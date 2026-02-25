import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
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
const WORKER_PID_FILENAME = "worker.pid";
const CANCEL_LOG_PATH = "logs/cancel.log";
const PROCESS_EXIT_GRACE_MILLIS = 400;

const normalizePath = (path: string): string => {
  if (path.length <= 1) {
    return path;
  }

  return path.endsWith("/") ? path.slice(0, -1) : path;
};

const joinPath = (base: string, child: string): string =>
  normalizePath(base) === "/" ? `/${child}` : `${normalizePath(base)}/${child}`;

const sleep = (millis: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, millis);
  });

const runDirectoryFor = (runsDirectory: string, runId: string): string =>
  joinPath(runsDirectory, runId);

const workerPidPathFor = (runDirectory: string): string =>
  joinPath(runDirectory, WORKER_PID_FILENAME);

const appendCancelLog = (runDirectory: string, message: string): void => {
  const logPath = joinPath(runDirectory, CANCEL_LOG_PATH);
  const logDirectory = logPath.slice(0, logPath.lastIndexOf("/"));
  const timestamp = new Date().toISOString();

  try {
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.appendFileSync(logPath, `${timestamp} ${message}\n`, "utf-8");
  } catch {
    // best effort logging only
  }
};

const readWorkerPid = (runDirectory: string): number | undefined => {
  const pidPath = workerPidPathFor(runDirectory);

  try {
    const raw = fs.readFileSync(pidPath, "utf-8").trim();
    const parsed = Number.parseInt(raw, 10);

    if (!Number.isInteger(parsed) || parsed <= 0) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
};

const removeWorkerPidFile = (runDirectory: string): void => {
  try {
    fs.rmSync(workerPidPathFor(runDirectory), { force: true });
  } catch {
    // best effort cleanup only
  }
};

const readProcessCommand = (pid: number): string | undefined => {
  const output = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (output.status !== 0) {
    return undefined;
  }

  const commandLine = output.stdout.trim();
  return commandLine.length > 0 ? commandLine : undefined;
};

const readProcessTable = (): ReadonlyArray<{ pid: number; ppid: number }> => {
  const output = spawnSync("ps", ["-ax", "-o", "pid=,ppid="], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (output.status !== 0) {
    return [];
  }

  return output.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/))
    .map(([pidText, ppidText]) => ({
      pid: Number.parseInt(pidText ?? "", 10),
      ppid: Number.parseInt(ppidText ?? "", 10),
    }))
    .filter((entry) => Number.isInteger(entry.pid) && Number.isInteger(entry.ppid));
};

const descendantsFor = (
  rootPid: number,
  table: ReadonlyArray<{ pid: number; ppid: number }>,
): number[] => {
  const byParent = new Map<number, Array<number>>();

  for (const entry of table) {
    const children = byParent.get(entry.ppid);
    if (children === undefined) {
      byParent.set(entry.ppid, [entry.pid]);
    } else {
      children.push(entry.pid);
    }
  }

  const descendants: Array<number> = [];
  const stack: Array<number> = [...(byParent.get(rootPid) ?? [])];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }

    descendants.push(current);

    const nested = byParent.get(current);
    if (nested !== undefined) {
      stack.push(...nested);
    }
  }

  return descendants;
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sendSignal = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

const looksLikeMillWorkerCommand = (commandLine: string, runId: string): boolean => {
  if (!commandLine.includes("_worker")) {
    return false;
  }

  return commandLine.includes(`--run-id ${runId}`);
};

const terminateWorkerProcessTree = async (runsDirectory: string, runId: string): Promise<void> => {
  const runDirectory = runDirectoryFor(runsDirectory, runId);
  const workerPid = readWorkerPid(runDirectory);

  if (workerPid === undefined) {
    appendCancelLog(runDirectory, `cancel:kill skipped run=${runId} reason=no-worker-pid`);
    return;
  }

  const commandLine = readProcessCommand(workerPid);

  if (commandLine === undefined) {
    appendCancelLog(
      runDirectory,
      `cancel:kill stale-pid run=${runId} pid=${workerPid} reason=command-missing`,
    );
    removeWorkerPidFile(runDirectory);
    return;
  }

  if (!looksLikeMillWorkerCommand(commandLine, runId)) {
    appendCancelLog(
      runDirectory,
      `cancel:kill skipped run=${runId} pid=${workerPid} reason=pid-mismatch command=${commandLine}`,
    );
    return;
  }

  const table = readProcessTable();
  const descendants = descendantsFor(workerPid, table);
  const targets = [...new Set([...descendants, workerPid])];

  const termCount = targets.reduce(
    (count, pid) => (sendSignal(pid, "SIGTERM") ? count + 1 : count),
    0,
  );

  appendCancelLog(
    runDirectory,
    `cancel:kill term-sent run=${runId} pid=${workerPid} targets=${targets.length} signaled=${termCount}`,
  );

  await sleep(PROCESS_EXIT_GRACE_MILLIS);

  const survivors = targets.filter((pid) => isProcessAlive(pid));
  const killCount = survivors.reduce(
    (count, pid) => (sendSignal(pid, "SIGKILL") ? count + 1 : count),
    0,
  );

  appendCancelLog(
    runDirectory,
    `cancel:kill kill-sent run=${runId} pid=${workerPid} survivors=${survivors.length} signaled=${killCount}`,
  );

  if (!isProcessAlive(workerPid)) {
    removeWorkerPidFile(runDirectory);
  }
};

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
  const runDirectory = runDirectoryFor(engineContext.runsDirectory, input.runId);
  const workerPidPath = workerPidPathFor(runDirectory);

  fs.mkdirSync(runDirectory, { recursive: true });
  fs.writeFileSync(workerPidPath, `${process.pid}\n`, "utf-8");

  try {
    return await runWithBunContext(
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
  } finally {
    removeWorkerPidFile(runDirectory);
  }
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

  await terminateWorkerProcessTree(engineContext.runsDirectory, input.runId);

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
