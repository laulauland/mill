import * as FileSystem from "effect/FileSystem";
import { Data, Effect } from "effect";
import { makeProgramContext, withProgramContextPromise } from "./program-context.adapter";
import { createTaskActorFromEffect } from "./task-actor.api";
import type { ExtensionRegistration, TaskInput, TaskResult } from "./types";

export class ProgramHostError extends Data.TaggedError("ProgramHostError")<{
  readonly runId: string;
  readonly message: string;
}> {}

export interface ExecuteProgramInProcessHostInput {
  readonly runId: string;
  readonly runDirectory: string;
  readonly workingDirectory: string;
  readonly programPath: string;
  readonly programSource: string;
  readonly executablePath?: string;
  readonly extensions: ReadonlyArray<ExtensionRegistration>;
  readonly env?: Readonly<Record<string, string>>;
  readonly task: (input: TaskInput) => Effect.Effect<TaskResult, unknown>;
  readonly onIo?: (input: {
    readonly stream: "stdout" | "stderr";
    readonly line: string;
  }) => Effect.Effect<void>;
}

const normalizePath = (path: string): string => {
  if (path.length <= 1) {
    return path;
  }

  return path.endsWith("/") ? path.slice(0, -1) : path;
};

const joinPath = (base: string, child: string): string =>
  normalizePath(base) === "/" ? `/${child}` : `${normalizePath(base)}/${child}`;

const dirname = (path: string): string => {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");

  if (index <= 0) {
    return "/";
  }

  return normalized.slice(0, index);
};

const toMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") {
      return message;
    }
  }

  return String(error);
};

const coreSourceDirectory = (): string =>
  normalizePath(decodeURIComponent(new URL(".", import.meta.url).pathname));

const coreProgramApiPath = (): string => joinPath(coreSourceDirectory(), "program.api.ts");

const importSpecifierFor = (programPath: string, runId: string): string =>
  `${programPath}?millRun=${encodeURIComponent(runId)}`;

const ensureCoreProgramExportResolution = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly runId: string;
  readonly programPath: string;
}): Effect.Effect<void, ProgramHostError> =>
  Effect.gen(function* () {
    const programDirectory = dirname(input.programPath);
    const corePackageDirectory = joinPath(programDirectory, "node_modules/@mill/core");
    const packageJsonPath = joinPath(corePackageDirectory, "package.json");
    const programShimPath = joinPath(corePackageDirectory, "program.ts");

    const existingPackage = yield* Effect.mapError(
      input.fileSystem.exists(packageJsonPath),
      (error) =>
        new ProgramHostError({
          runId: input.runId,
          message: `Unable to inspect ${packageJsonPath}: ${toMessage(error)}`,
        }),
    );

    if (existingPackage) {
      return;
    }

    yield* Effect.mapError(
      input.fileSystem.makeDirectory(corePackageDirectory, { recursive: true }),
      (error) =>
        new ProgramHostError({
          runId: input.runId,
          message: `Unable to create ${corePackageDirectory}: ${toMessage(error)}`,
        }),
    );

    yield* Effect.mapError(
      input.fileSystem.writeFileString(
        packageJsonPath,
        JSON.stringify({ type: "module", exports: { "./program": "./program.ts" } }, undefined, 2),
      ),
      (error) =>
        new ProgramHostError({
          runId: input.runId,
          message: `Unable to write ${packageJsonPath}: ${toMessage(error)}`,
        }),
    );

    yield* Effect.mapError(
      input.fileSystem.writeFileString(
        programShimPath,
        `export * from ${JSON.stringify(coreProgramApiPath())};\n`,
      ),
      (error) =>
        new ProgramHostError({
          runId: input.runId,
          message: `Unable to write ${programShimPath}: ${toMessage(error)}`,
        }),
    );
  });

const moduleResult = (module: unknown): unknown => {
  if (typeof module !== "object" || module === null) {
    return undefined;
  }

  const record = module as Readonly<Record<string, unknown>>;

  if ("result" in record) {
    return record.result;
  }

  if ("default" in record) {
    return record.default;
  }

  return undefined;
};

const inferProgramResult = (
  module: unknown,
  completedTasks: ReadonlyArray<TaskResult>,
): unknown => {
  const explicit = moduleResult(module);

  if (explicit !== undefined) {
    return explicit;
  }

  if (completedTasks.length === 1) {
    return completedTasks[0]?.text;
  }

  return undefined;
};

export const executeProgramInProcessHost = (
  input: ExecuteProgramInProcessHostInput,
): Effect.Effect<unknown, ProgramHostError> =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>();
    const fileSystem = yield* FileSystem.FileSystem;
    const runDirectory = normalizePath(input.runDirectory);
    const markerPath = joinPath(runDirectory, "program-host.marker");
    const completedTasks: Array<TaskResult> = [];

    yield* Effect.mapError(
      fileSystem.makeDirectory(runDirectory, { recursive: true }),
      (error) =>
        new ProgramHostError({
          runId: input.runId,
          message: `Unable to ensure run directory ${runDirectory}: ${toMessage(error)}`,
        }),
    );

    yield* Effect.mapError(
      fileSystem.writeFileString(
        markerPath,
        ["program-host:import", `runId=${input.runId}`, `programPath=${input.programPath}`].join(
          "\n",
        ),
      ),
      (error) =>
        new ProgramHostError({
          runId: input.runId,
          message: `Unable to write program host marker: ${toMessage(error)}`,
        }),
    );

    yield* ensureCoreProgramExportResolution({
      fileSystem,
      runId: input.runId,
      programPath: input.programPath,
    });

    const context = makeProgramContext({
      extensions: input.extensions,
      completedTasks: () => completedTasks,
      task: (taskInput) =>
        createTaskActorFromEffect(taskInput, {
          execute: input.task,
          runId: input.runId,
          onComplete: (result) => {
            completedTasks.push(result);
          },
          services,
        }),
    });

    yield* Effect.logDebug("mill.program-host:import:start", {
      runId: input.runId,
      programPath: input.programPath,
      workingDirectory: input.workingDirectory,
    });

    const originalLog = globalThis.console.log;
    const originalError = globalThis.console.error;
    const publishProgramIo = (stream: "stdout" | "stderr", args: ReadonlyArray<unknown>): void => {
      const line = args.map(toMessage).join(" ");
      if (line.length === 0 || input.onIo === undefined) {
        return;
      }
      Effect.runForkWith(services)(input.onIo({ stream, line }));
    };

    const module = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        globalThis.console.log = (...args: ReadonlyArray<unknown>) => {
          originalLog(...args);
          publishProgramIo("stdout", args);
        };
        globalThis.console.error = (...args: ReadonlyArray<unknown>) => {
          originalError(...args);
          publishProgramIo("stderr", args);
        };
      }),
      () =>
        Effect.tryPromise({
          try: () =>
            withProgramContextPromise(
              context,
              () => import(importSpecifierFor(input.programPath, input.runId)),
            ),
          catch: (error) =>
            new ProgramHostError({
              runId: input.runId,
              message: `Program import failed: ${toMessage(error)}`,
            }),
        }),
      () =>
        Effect.sync(() => {
          globalThis.console.log = originalLog;
          globalThis.console.error = originalError;
        }),
    );

    const result = inferProgramResult(module, completedTasks);

    yield* Effect.logDebug("mill.program-host:import:complete", {
      runId: input.runId,
      taskCount: completedTasks.length,
    });

    return result;
  });
