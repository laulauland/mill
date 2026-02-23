import * as FileSystem from "@effect/platform/FileSystem";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime } from "effect";
import { makeMillEngine, ProgramExecutionError } from "../engine.effect";
import { makeDriverRegistry } from "../driver-registry.effect";
import { makeExecutorRegistry } from "../executor-registry.effect";
import { decodeRunIdSync, type RunRecord, type RunSyncOutput } from "../run.schema";
import { runDetachedWorker } from "../worker.effect";
import { decodeSpawnOptions } from "../spawn.schema";
import { resolveConfig } from "./config-loader.api";
import type {
  ConfigOverrides,
  ExecutorRuntime,
  ExtensionRegistration,
  ResolveConfigOptions,
  SpawnInput,
  SpawnOutput,
} from "./types";

const runtime = Runtime.defaultRuntime;

type ProgramRunner = () => Promise<unknown>;

type AsyncFunctionConstructor = new (...args: ReadonlyArray<string>) => ProgramRunner;

const ProgramAsyncFunction = Object.getPrototypeOf(async () => undefined)
  .constructor as AsyncFunctionConstructor;

interface GlobalMillContext {
  mill?: {
    spawn: (input: SpawnInput) => Promise<SpawnOutput>;
    [name: string]: unknown;
  };
}

interface BaseRunInput extends ResolveConfigOptions {
  readonly driverName?: string;
  readonly executorName?: string;
  readonly runsDirectory?: string;
}

export interface SubmitRunInput extends BaseRunInput {
  readonly programPath: string;
  readonly launchWorker: (input: LaunchWorkerInput) => Promise<void>;
}

export interface RunProgramSyncInput extends SubmitRunInput {
  readonly waitTimeoutSeconds?: number;
}

interface GetRunStatusInput extends Omit<
  ResolveConfigOptions,
  "pathExists" | "loadConfigOverrides"
> {
  readonly runId: string;
  readonly driverName?: string;
  readonly executorName?: string;
  readonly runsDirectory?: string;
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly loadConfigOverrides?: (path: string) => Promise<ConfigOverrides>;
}

export interface WaitForRunInput extends GetRunStatusInput {
  readonly timeoutSeconds: number;
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

const toExtensionApiBridge = (
  extensions: ReadonlyArray<ExtensionRegistration>,
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    extensions
      .filter((extension) => extension.api !== undefined)
      .map((extension) => {
        const api = extension.api ?? {};

        return [
          extension.name,
          Object.fromEntries(
            Object.entries(api).map(([methodName, method]) => [
              methodName,
              (...args: ReadonlyArray<unknown>) =>
                Runtime.runPromise(runtime)(Effect.provide(method(...args), BunContext.layer)),
            ]),
          ),
        ] as const;
      }),
  );

const executeProgramWithInjectedMill = (
  programSource: string,
  spawn: (input: SpawnInput) => Effect.Effect<SpawnOutput, unknown>,
  extensions: ReadonlyArray<ExtensionRegistration>,
): Effect.Effect<unknown, ProgramExecutionError> =>
  Effect.tryPromise({
    try: async () => {
      const globalContext = globalThis as GlobalMillContext;
      const previousMill = globalContext.mill;
      const programRunner = new ProgramAsyncFunction(programSource);
      const extensionApiBridge = toExtensionApiBridge(extensions);

      globalContext.mill = {
        spawn: async (input) => {
          const decodedInput = await Runtime.runPromise(runtime)(decodeSpawnOptions(input));
          return Runtime.runPromise(runtime)(Effect.provide(spawn(decodedInput), BunContext.layer));
        },
        ...extensionApiBridge,
      };

      try {
        return await programRunner();
      } finally {
        if (previousMill === undefined) {
          delete globalContext.mill;
        } else {
          globalContext.mill = previousMill;
        }
      }
    },
    catch: (error) =>
      new ProgramExecutionError({
        runId: "pending",
        message: String(error),
      }),
  });

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
    loadConfigOverrides: input.loadConfigOverrides,
  });

  const engineContext = await makeEngineForConfig(input);
  const result = await runWithBunContext(
    engineContext.engine.result(decodeRunIdSync(submittedRun.id)),
  );

  if (result === undefined) {
    throw new Error(`Run ${submittedRun.id} completed without persisted result.`);
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
            execute: executeProgramWithInjectedMill(
              programSource,
              spawn,
              engineContext.selectedExtensions,
            ),
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

  throw waitOutcome.left;
};
