import * as FileSystem from "@effect/platform/FileSystem";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime } from "effect";
import { makeMillEngine, type ProgramExecutionError } from "../engine.effect";
import { decodeRunIdSync, type RunRecord, type RunSyncOutput } from "../run.schema";
import { decodeSpawnOptions } from "../spawn.schema";
import { resolveConfig } from "./config-loader.api";
import type {
  ConfigOverrides,
  DriverRegistration,
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
  };
}

interface RunProgramSyncInput extends ResolveConfigOptions {
  readonly programPath: string;
  readonly driverName?: string;
  readonly runsDirectory?: string;
}

interface GetRunStatusInput extends Omit<
  ResolveConfigOptions,
  "pathExists" | "loadConfigOverrides"
> {
  readonly runId: string;
  readonly driverName?: string;
  readonly runsDirectory?: string;
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly loadConfigOverrides?: (path: string) => Promise<ConfigOverrides>;
}

export interface WaitForRunInput extends GetRunStatusInput {
  readonly timeoutSeconds: number;
}

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

const resolveRuntimeDriver = (
  registration: DriverRegistration | undefined,
  fallback: DriverRegistration | undefined,
) => {
  if (registration?.runtime !== undefined) {
    return registration.runtime;
  }

  return fallback?.runtime;
};

const executeProgramWithInjectedMill = (
  programSource: string,
  spawn: (input: SpawnInput) => Effect.Effect<SpawnOutput, unknown>,
): Effect.Effect<unknown, ProgramExecutionError> =>
  Effect.tryPromise({
    try: async () => {
      const globalContext = globalThis as GlobalMillContext;
      const previousMill = globalContext.mill;
      const programRunner = new ProgramAsyncFunction(programSource);

      globalContext.mill = {
        spawn: async (input) => {
          const decodedInput = await Runtime.runPromise(runtime)(decodeSpawnOptions(input));
          return Runtime.runPromise(runtime)(Effect.provide(spawn(decodedInput), BunContext.layer));
        },
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

const makeEngineForConfig = async (
  input: GetRunStatusInput,
): Promise<ReturnType<typeof makeMillEngine>> => {
  const cwd = input.cwd ?? process.cwd();
  const resolvedConfig = await resolveConfig(input);
  const selectedDriverName = input.driverName ?? resolvedConfig.config.defaultDriver;
  const selectedDriver = resolvedConfig.config.drivers[selectedDriverName];
  const fallbackDriver = resolvedConfig.config.drivers[resolvedConfig.config.defaultDriver];
  const runtimeDriver = resolveRuntimeDriver(selectedDriver, fallbackDriver);
  const runsDirectory = resolveRunsDirectory(cwd, input.homeDirectory, input.runsDirectory);

  return makeMillEngine({
    runsDirectory,
    driverName: selectedDriverName,
    defaultModel: resolvedConfig.config.defaultModel,
    driver: runtimeDriver ?? fallbackDriver.runtime!,
  });
};

export const runProgramSync = async (input: RunProgramSyncInput): Promise<RunSyncOutput> => {
  const cwd = input.cwd ?? process.cwd();
  const resolvedConfig = await resolveConfig(input);
  const selectedDriverName = input.driverName ?? resolvedConfig.config.defaultDriver;
  const selectedDriver = resolvedConfig.config.drivers[selectedDriverName];
  const fallbackDriver = resolvedConfig.config.drivers[resolvedConfig.config.defaultDriver];
  const runtimeDriver = resolveRuntimeDriver(selectedDriver, fallbackDriver);
  const programPath = resolveProgramPath(cwd, input.programPath);
  const runsDirectory = resolveRunsDirectory(cwd, input.homeDirectory, input.runsDirectory);

  const programSource = await runWithBunContext(readProgramSource(programPath));

  const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);
  const engine = makeMillEngine({
    runsDirectory,
    driverName: selectedDriverName,
    defaultModel: resolvedConfig.config.defaultModel,
    driver: runtimeDriver ?? fallbackDriver.runtime!,
  });

  return runWithBunContext(
    engine.runSync({
      runId,
      programPath,
      executeProgram: (spawn) => executeProgramWithInjectedMill(programSource, spawn),
    }),
  );
};

export const getRunStatus = async (input: GetRunStatusInput): Promise<RunRecord> => {
  const engine = await makeEngineForConfig(input);

  return runWithBunContext(engine.status(decodeRunIdSync(input.runId)));
};

export const waitForRun = async (input: WaitForRunInput): Promise<RunRecord> => {
  const engine = await makeEngineForConfig(input);
  const waitOutcome = await runWithBunContext(
    Effect.either(engine.wait(decodeRunIdSync(input.runId), Math.round(input.timeoutSeconds * 1000))),
  );

  if (waitOutcome._tag === "Right") {
    return waitOutcome.right;
  }

  throw waitOutcome.left;
};
