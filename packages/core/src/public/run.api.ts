import * as FileSystem from "@effect/platform/FileSystem";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime, Stream } from "effect";
import { makeMillEngine, ProgramExecutionError, type InspectResult } from "../engine.effect";
import { makeDriverRegistry } from "../driver-registry.effect";
import { makeExecutorRegistry } from "../executor-registry.effect";
import {
  decodeRunIdSync,
  decodeSpawnIdSync,
  type RunRecord,
  type RunSyncOutput,
} from "../run.schema";
import { runDetachedWorker } from "../worker.effect";
import { executeProgramInProcessHost } from "../program-host.effect";
import { resolveConfig } from "./config-loader.api";
import type {
  DriverSessionPointer,
  ExecutorRuntime,
  ExtensionRegistration,
  ResolveConfigOptions,
} from "./types";

const runtime = Runtime.defaultRuntime;

interface BaseRunInput extends ResolveConfigOptions {
  readonly driverName?: string;
  readonly executorName?: string;
  readonly runsDirectory?: string;
}

export interface SubmitRunInput extends BaseRunInput {
  readonly programPath: string;
  readonly launchWorker: (input: LaunchWorkerInput) => Promise<void>;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface RunProgramSyncInput extends SubmitRunInput {
  readonly waitTimeoutSeconds?: number;
}

interface GetRunStatusInput extends Omit<ResolveConfigOptions, "pathExists" | "loadConfigModule"> {
  readonly runId: string;
  readonly driverName?: string;
  readonly executorName?: string;
  readonly runsDirectory?: string;
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly loadConfigModule?: (path: string) => Promise<unknown>;
}

export interface WaitForRunInput extends GetRunStatusInput {
  readonly timeoutSeconds: number;
}

export interface WatchRunInput extends Omit<
  GetRunStatusInput,
  "runId" | "pathExists" | "loadConfigModule"
> {
  readonly runId?: string;
  readonly raw?: boolean;
  readonly sinceTimeIso?: string;
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly loadConfigModule?: (path: string) => Promise<unknown>;
  readonly onEvent: (line: string) => void;
}

export interface InspectRunInput extends BaseRunInput {
  readonly ref: string;
  readonly session?: boolean;
}

export interface CancelRunInput extends GetRunStatusInput {
  readonly reason?: string;
}

export interface ListRunsInput extends BaseRunInput {
  readonly status?: RunRecord["status"];
}

export interface RunWorkerInput extends BaseRunInput {
  readonly runId: string;
  readonly programPath: string;
}

export interface LaunchWorkerInput {
  readonly runId: string;
  readonly programPath: string;
  readonly runsDirectory: string;
  readonly driverName: string;
  readonly executorName: string;
  readonly cwd: string;
}

interface EngineContext {
  readonly engine: ReturnType<typeof makeMillEngine>;
  readonly selectedDriverName: string;
  readonly selectedExecutorName: string;
  readonly selectedExecutorRuntime: ExecutorRuntime;
  readonly selectedExtensions: ReadonlyArray<ExtensionRegistration>;
  readonly runsDirectory: string;
}

const DEFAULT_SYNC_WAIT_TIMEOUT_SECONDS = 60 * 60 * 24 * 365;

const normalizePath = (path: string): string => {
  if (path.length <= 1) {
    return path;
  }

  return path.endsWith("/") ? path.slice(0, -1) : path;
};

const joinPath = (base: string, child: string): string =>
  normalizePath(base) === "/" ? `/${child}` : `${normalizePath(base)}/${child}`;

const resolveProgramPath = (cwd: string, programPath: string): string =>
  programPath.startsWith("/") ? normalizePath(programPath) : joinPath(cwd, programPath);

const resolveRunsDirectory = (
  cwd: string,
  homeDirectory: string | undefined,
  runsDirectory: string | undefined,
): string => {
  if (runsDirectory !== undefined && runsDirectory.length > 0) {
    return runsDirectory;
  }

  if (homeDirectory !== undefined && homeDirectory.length > 0) {
    return joinPath(homeDirectory, ".mill/runs");
  }

  return joinPath(cwd, ".mill/runs");
};

const runWithBunContext = <A, E>(effect: Effect.Effect<A, E, BunContext.BunContext>): Promise<A> =>
  Runtime.runPromise(runtime)(Effect.provide(effect, BunContext.layer));

const readProgramSource = (
  programPath: string,
): Effect.Effect<string, unknown, BunContext.BunContext> =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.readFileString(programPath, "utf-8"),
  );

const writeSubmissionArtifacts = (
  run: RunRecord,
  programSource: string,
): Effect.Effect<void, unknown, BunContext.BunContext> =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    Effect.gen(function* () {
      const copiedProgramPath = joinPath(run.paths.runDir, "program.ts");
      const logsDirectory = joinPath(run.paths.runDir, "logs");
      const workerLogPath = joinPath(logsDirectory, "worker.log");

      yield* fileSystem.writeFileString(copiedProgramPath, programSource);
      yield* fileSystem.makeDirectory(logsDirectory, { recursive: true });
      yield* fileSystem.writeFileString(workerLogPath, "");
    }),
  );

const makeEngineForConfig = async (input: BaseRunInput): Promise<EngineContext> => {
  const cwd = input.cwd ?? process.cwd();
  const resolvedConfig = await resolveConfig(input);
  const driverRegistry = makeDriverRegistry({
    defaultDriver: resolvedConfig.config.defaultDriver,
    drivers: resolvedConfig.config.drivers,
  });
  const executorRegistry = makeExecutorRegistry({
    defaultExecutor: resolvedConfig.config.defaultExecutor,
    executors: resolvedConfig.config.executors,
  });
  const selectedDriver = await Runtime.runPromise(runtime)(
    driverRegistry.resolve(input.driverName),
  );
  const selectedExecutor = await Runtime.runPromise(runtime)(
    executorRegistry.resolve(input.executorName),
  );
  const runsDirectory = resolveRunsDirectory(cwd, input.homeDirectory, input.runsDirectory);

  return {
    selectedDriverName: selectedDriver.name,
    selectedExecutorName: selectedExecutor.name,
    selectedExecutorRuntime: selectedExecutor.runtime,
    selectedExtensions: resolvedConfig.config.extensions,
    runsDirectory,
    engine: makeMillEngine({
      runsDirectory,
      driverName: selectedDriver.name,
      executorName: selectedExecutor.name,
      defaultModel: resolvedConfig.config.defaultModel,
      driver: selectedDriver.runtime,
      extensions: resolvedConfig.config.extensions,
    }),
  };
};

const parseInspectRef = (
  ref: string,
):
  | {
      runId: string;
      spawnId?: string;
    }
  | undefined => {
  const [runIdPart, spawnIdPart] = ref.split(".");

  if (runIdPart === undefined || runIdPart.length === 0) {
    return undefined;
  }

  if (spawnIdPart === undefined || spawnIdPart.length === 0) {
    return {
      runId: runIdPart,
    };
  }

  return {
    runId: runIdPart,
    spawnId: spawnIdPart,
  };
};

const isRunTerminalEvent = (eventType: string): boolean =>
  eventType === "run:complete" || eventType === "run:failed" || eventType === "run:cancelled";

const isSinceTimeIso = (value: string): boolean => {
  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    return false;
  }

  return new Date(parsed).toISOString() === value;
};

export interface InspectSessionOutput extends DriverSessionPointer {
  readonly runId: string;
  readonly spawnId: string;
}

export const submitRun = async (input: SubmitRunInput): Promise<RunRecord> => {
  const cwd = input.cwd ?? process.cwd();
  const programPath = resolveProgramPath(cwd, input.programPath);
  const programSource = await runWithBunContext(readProgramSource(programPath));
  const engineContext = await makeEngineForConfig(input);
  const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);

  const submittedRun = await runWithBunContext(
    engineContext.engine.submit({
      runId,
      programPath,
      metadata: input.metadata,
    }),
  );

  await runWithBunContext(writeSubmissionArtifacts(submittedRun, programSource));

  const copiedProgramPath = joinPath(submittedRun.paths.runDir, "program.ts");

  await input.launchWorker({
    runId: submittedRun.id,
    programPath: copiedProgramPath,
    runsDirectory: engineContext.runsDirectory,
    driverName: engineContext.selectedDriverName,
    executorName: engineContext.selectedExecutorName,
    cwd,
  });

  return submittedRun;
};

export const runProgramSync = async (input: RunProgramSyncInput): Promise<RunSyncOutput> => {
  const submittedRun = await submitRun(input);
  const timeoutSeconds = input.waitTimeoutSeconds ?? DEFAULT_SYNC_WAIT_TIMEOUT_SECONDS;

  const terminalRun = await waitForRun({
    defaults: input.defaults,
    runId: submittedRun.id,
    timeoutSeconds,
    cwd: input.cwd,
    homeDirectory: input.homeDirectory,
    runsDirectory: input.runsDirectory,
    driverName: input.driverName,
    executorName: input.executorName,
    pathExists: input.pathExists,
    loadConfigModule: input.loadConfigModule,
  });

  const engineContext = await makeEngineForConfig(input);
  const result = await runWithBunContext(
    engineContext.engine.result(decodeRunIdSync(submittedRun.id)),
  );

  if (result === undefined) {
    return Promise.reject(new Error(`Run ${submittedRun.id} completed without persisted result.`));
  }

  return {
    run: terminalRun,
    result,
  };
};

export const runWorker = async (input: RunWorkerInput): Promise<RunSyncOutput> => {
  const cwd = input.cwd ?? process.cwd();
  const programPath = resolveProgramPath(cwd, input.programPath);
  const programSource = await runWithBunContext(readProgramSource(programPath));
  const engineContext = await makeEngineForConfig(input);

  return runWithBunContext(
    runDetachedWorker({
      engine: engineContext.engine,
      runId: decodeRunIdSync(input.runId),
      programPath,
      runsDirectory: engineContext.runsDirectory,
      executeProgram: (spawn) =>
        Effect.mapError(
          engineContext.selectedExecutorRuntime.runProgram({
            runId: input.runId,
            programPath,
            execute: executeProgramInProcessHost({
              runId: input.runId,
              runDirectory: joinPath(engineContext.runsDirectory, input.runId),
              workingDirectory: cwd,
              programPath,
              programSource,
              executorName: engineContext.selectedExecutorName,
              extensions: engineContext.selectedExtensions,
              spawn,
            }),
          }),
          (error) =>
            new ProgramExecutionError({
              runId: input.runId,
              message: String(error),
            }),
        ),
    }),
  );
};

export const getRunStatus = async (input: GetRunStatusInput): Promise<RunRecord> => {
  const engineContext = await makeEngineForConfig(input);

  return runWithBunContext(engineContext.engine.status(decodeRunIdSync(input.runId)));
};

export const waitForRun = async (input: WaitForRunInput): Promise<RunRecord> => {
  const engineContext = await makeEngineForConfig(input);
  const waitOutcome = await runWithBunContext(
    Effect.either(
      engineContext.engine.wait(
        decodeRunIdSync(input.runId),
        Math.round(input.timeoutSeconds * 1000),
      ),
    ),
  );

  if (waitOutcome._tag === "Right") {
    return waitOutcome.right;
  }

  return Promise.reject(waitOutcome.left);
};

export const watchRun = async (input: WatchRunInput): Promise<void> => {
  if (input.sinceTimeIso !== undefined && !isSinceTimeIso(input.sinceTimeIso)) {
    return Promise.reject(
      new Error(`Invalid --since-time value '${input.sinceTimeIso}'. Expected ISO timestamp.`),
    );
  }

  const engineContext = await makeEngineForConfig(input);

  if (input.runId === undefined) {
    if (input.raw === true) {
      return Promise.reject(new Error("watch --raw requires a runId."));
    }

    await runWithBunContext(
      Effect.scoped(
        Stream.runForEach(engineContext.engine.watchAll(input.sinceTimeIso), (event) =>
          Effect.sync(() => {
            input.onEvent(JSON.stringify(event));
          }),
        ),
      ),
    );

    return;
  }

  const runId = decodeRunIdSync(input.runId);

  if (input.raw === true) {
    await runWithBunContext(
      Effect.raceFirst(
        Effect.scoped(
          Stream.runForEach(engineContext.engine.watchRaw(runId), (line) =>
            Effect.sync(() => {
              input.onEvent(line);
            }),
          ),
        ),
        engineContext.engine.wait(runId, DEFAULT_SYNC_WAIT_TIMEOUT_SECONDS * 1000),
      ),
    );

    return;
  }

  const watchStream = Stream.filter(engineContext.engine.watch(runId), (event) =>
    input.sinceTimeIso === undefined ? true : event.timestamp >= input.sinceTimeIso,
  );

  await runWithBunContext(
    Effect.scoped(
      Stream.runForEach(
        Stream.takeUntil(watchStream, (event) => isRunTerminalEvent(event.type)),
        (event) =>
          Effect.sync(() => {
            input.onEvent(JSON.stringify(event));
          }),
      ),
    ),
  );
};

export const inspectRun = async (
  input: InspectRunInput,
): Promise<InspectResult | InspectSessionOutput> => {
  const parsedRef = parseInspectRef(input.ref);

  if (parsedRef === undefined) {
    return Promise.reject(new Error("inspect reference requires a runId"));
  }

  const engineContext = await makeEngineForConfig(input);
  const inspected = await runWithBunContext(
    engineContext.engine.inspect({
      runId: decodeRunIdSync(parsedRef.runId),
      spawnId: parsedRef.spawnId === undefined ? undefined : decodeSpawnIdSync(parsedRef.spawnId),
    }),
  );

  if (input.session !== true) {
    return inspected;
  }

  if (inspected.kind !== "spawn" || inspected.result === undefined) {
    return Promise.reject(
      new Error("inspect --session requires a runId.spawnId reference with completed spawn result"),
    );
  }

  const resolvedConfig = await resolveConfig(input);
  const driverRegistry = makeDriverRegistry({
    defaultDriver: resolvedConfig.config.defaultDriver,
    drivers: resolvedConfig.config.drivers,
  });
  const run = await runWithBunContext(
    engineContext.engine.status(decodeRunIdSync(parsedRef.runId)),
  );
  const resolvedDriver = await Runtime.runPromise(runtime)(driverRegistry.resolve(run.driver));

  if (resolvedDriver.runtime.resolveSession === undefined) {
    return Promise.reject(
      new Error(`Driver ${resolvedDriver.name} does not support session inspection`),
    );
  }

  const sessionPointer = await Runtime.runPromise(runtime)(
    Effect.provide(
      resolvedDriver.runtime.resolveSession({
        sessionRef: inspected.result.sessionRef,
      }),
      BunContext.layer,
    ),
  );

  return {
    runId: parsedRef.runId,
    spawnId: inspected.spawnId,
    ...sessionPointer,
  } satisfies InspectSessionOutput;
};

export const cancelRun = async (
  input: CancelRunInput,
): Promise<{
  runId: string;
  status: RunRecord["status"];
  alreadyTerminal: boolean;
}> => {
  const engineContext = await makeEngineForConfig(input);
  const cancelled = await runWithBunContext(
    engineContext.engine.cancel(decodeRunIdSync(input.runId), input.reason),
  );

  return {
    runId: cancelled.run.id,
    status: cancelled.run.status,
    alreadyTerminal: cancelled.alreadyTerminal,
  };
};

export const listRuns = async (input: ListRunsInput): Promise<ReadonlyArray<RunRecord>> => {
  const engineContext = await makeEngineForConfig(input);

  return runWithBunContext(engineContext.engine.list(input.status));
};
