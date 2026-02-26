import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as FileSystem from "@effect/platform/FileSystem";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Fiber, Runtime, Stream } from "effect";
import { makeMillEngine, ProgramExecutionError } from "../engine.effect";
import { makeDriverRegistry } from "../driver-registry.effect";
import { makeExecutorRegistry } from "../executor-registry.effect";
import { type MillEvent } from "../event.schema";
import { decodeRunIdSync, type RunRecord, type RunSyncOutput } from "../run.schema";
import { runDetachedWorker } from "../worker.effect";
import { executeProgramInProcessHost } from "../program-host.effect";
import { publishIoEvent, type IoStreamEvent } from "../observer-hub.effect";
import { resolveConfig } from "./config-loader.api";
import type { ExecutorRuntime, ExtensionRegistration, ResolveConfigOptions } from "./types";

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

export type WatchChannel = "events" | "io" | "all";
export type WatchSource = "driver" | "program";

export type WatchOutput =
  | {
      readonly kind: "event";
      readonly runId: string;
      readonly event: MillEvent;
    }
  | {
      readonly kind: "io";
      readonly runId: string;
      readonly source: WatchSource;
      readonly stream: "stdout" | "stderr";
      readonly line: string;
      readonly timestamp: string;
      readonly spawnId?: string;
    };

export interface WatchRunInput extends Omit<
  GetRunStatusInput,
  "runId" | "pathExists" | "loadConfigModule"
> {
  readonly runId?: string;
  readonly channel?: WatchChannel;
  readonly source?: WatchSource;
  readonly spawnId?: string;
  readonly sinceTimeIso?: string;
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly loadConfigModule?: (path: string) => Promise<unknown>;
  readonly onEvent: (line: string) => void;
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
  readonly runDepth?: number;
}

export interface LaunchWorkerInput {
  readonly runId: string;
  readonly programPath: string;
  readonly runsDirectory: string;
  readonly driverName: string;
  readonly executorName: string;
  readonly cwd: string;
  readonly runDepth: number;
}

interface EngineContext {
  readonly engine: ReturnType<typeof makeMillEngine>;
  readonly selectedDriverName: string;
  readonly selectedExecutorName: string;
  readonly selectedExecutorRuntime: ExecutorRuntime;
  readonly selectedExtensions: ReadonlyArray<ExtensionRegistration>;
  readonly runsDirectory: string;
  readonly maxRunDepth: number;
}

const DEFAULT_SYNC_WAIT_TIMEOUT_SECONDS = 60 * 60 * 24 * 365;
const WORKER_PID_FILENAME = "worker.pid";
const CANCEL_LOG_PATH = "logs/cancel.log";
const PROCESS_EXIT_GRACE_MILLIS = 400;
const RUN_DEPTH_ENV = "MILL_RUN_DEPTH";
const DEFAULT_MAX_RUN_DEPTH = 1;

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

const parseInteger = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed)) {
    return undefined;
  }

  return parsed;
};

const resolveCurrentRunDepth = (): number => {
  const parsed = parseInteger(process.env[RUN_DEPTH_ENV]);

  if (parsed === undefined || parsed < 0) {
    return 0;
  }

  return parsed;
};

const resolveMaxRunDepth = (configured: number | undefined): number => {
  if (configured === undefined || !Number.isInteger(configured) || configured <= 0) {
    return DEFAULT_MAX_RUN_DEPTH;
  }

  return configured;
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
    maxRunDepth: resolveMaxRunDepth(resolvedConfig.config.maxRunDepth),
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

const isRunTerminalEvent = (eventType: string): boolean =>
  eventType === "run:complete" || eventType === "run:failed" || eventType === "run:cancelled";

const isSinceTimeIso = (value: string): boolean => {
  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    return false;
  }

  return new Date(parsed).toISOString() === value;
};

const toWatchEventOutput = (event: MillEvent): WatchOutput => ({
  kind: "event",
  runId: event.runId,
  event,
});

const toWatchIoOutput = (event: IoStreamEvent): WatchOutput => ({
  kind: "io",
  runId: event.runId,
  source: event.source,
  stream: event.stream,
  line: event.line,
  timestamp: event.timestamp,
  spawnId: event.spawnId,
});

const emitWatchOutput = (
  onEvent: (line: string) => void,
  output: WatchOutput,
): Effect.Effect<void> =>
  Effect.sync(() => {
    onEvent(JSON.stringify(output));
  });

const filterIoEvent = (
  event: IoStreamEvent,
  source: WatchSource | undefined,
  spawnId: string | undefined,
): boolean => {
  if (source !== undefined && event.source !== source) {
    return false;
  }

  if (spawnId !== undefined && event.spawnId !== spawnId) {
    return false;
  }

  return true;
};

export const submitRun = async (input: SubmitRunInput): Promise<RunRecord> => {
  const cwd = input.cwd ?? process.cwd();
  const programPath = resolveProgramPath(cwd, input.programPath);
  const programSource = await runWithBunContext(readProgramSource(programPath));
  const engineContext = await makeEngineForConfig(input);
  const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);

  const currentRunDepth = resolveCurrentRunDepth();
  const nextRunDepth = currentRunDepth + 1;

  if (nextRunDepth > engineContext.maxRunDepth) {
    return Promise.reject(
      new Error(
        `Run depth ${nextRunDepth} exceeds configured maxRunDepth=${engineContext.maxRunDepth}.`,
      ),
    );
  }

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
    runDepth: nextRunDepth,
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
  const runDepth = input.runDepth ?? resolveCurrentRunDepth();

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
                env: {
                  [RUN_DEPTH_ENV]: String(runDepth),
                },
                spawn,
                onIo: ({ stream, line }) =>
                  Effect.flatMap(
                    Effect.sync(() => new Date().toISOString()),
                    (timestamp) =>
                      publishIoEvent({
                        runId: input.runId,
                        source: "program",
                        stream,
                        line,
                        timestamp,
                      }),
                  ),
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

  const channel = input.channel ?? "events";

  if (input.runId === undefined && channel !== "events") {
    return Promise.reject(new Error("watch --channel io|all requires --run <runId>."));
  }

  if (input.runId === undefined && (input.source !== undefined || input.spawnId !== undefined)) {
    return Promise.reject(new Error("watch --source/--spawn requires --run <runId>."));
  }

  if (channel === "io" && input.sinceTimeIso !== undefined) {
    return Promise.reject(new Error("watch --channel io does not support --since-time."));
  }

  if (channel === "events" && (input.source !== undefined || input.spawnId !== undefined)) {
    return Promise.reject(
      new Error("watch --source/--spawn require --channel io or --channel all."),
    );
  }

  const engineContext = await makeEngineForConfig(input);

  if (input.runId === undefined) {
    await runWithBunContext(
      Effect.scoped(
        Stream.runForEach(engineContext.engine.watchAll(input.sinceTimeIso), (event) =>
          emitWatchOutput(input.onEvent, toWatchEventOutput(event)),
        ),
      ),
    );

    return;
  }

  const runId = decodeRunIdSync(input.runId);

  const eventStream = Stream.filter(engineContext.engine.watch(runId), (event) =>
    input.sinceTimeIso === undefined ? true : event.timestamp >= input.sinceTimeIso,
  );

  const ioStream = Stream.filter(engineContext.engine.watchIo(runId), (event) =>
    filterIoEvent(event, input.source, input.spawnId),
  );

  if (channel === "events") {
    await runWithBunContext(
      Effect.scoped(
        Stream.runForEach(
          Stream.takeUntil(eventStream, (event) => isRunTerminalEvent(event.type)),
          (event) => emitWatchOutput(input.onEvent, toWatchEventOutput(event)),
        ),
      ),
    );

    return;
  }

  const currentRun = await runWithBunContext(engineContext.engine.status(runId));

  if (
    currentRun.status === "complete" ||
    currentRun.status === "failed" ||
    currentRun.status === "cancelled"
  ) {
    if (channel === "all") {
      await runWithBunContext(
        Effect.scoped(
          Stream.runForEach(
            Stream.takeUntil(eventStream, (event) => isRunTerminalEvent(event.type)),
            (event) => emitWatchOutput(input.onEvent, toWatchEventOutput(event)),
          ),
        ),
      );
    }

    return;
  }

  if (channel === "io") {
    await runWithBunContext(
      Effect.raceFirst(
        Effect.scoped(
          Stream.runForEach(ioStream, (event) =>
            emitWatchOutput(input.onEvent, toWatchIoOutput(event)),
          ),
        ),
        engineContext.engine.wait(runId, DEFAULT_SYNC_WAIT_TIMEOUT_SECONDS * 1000),
      ),
    );

    return;
  }

  await runWithBunContext(
    Effect.scoped(
      Effect.gen(function* () {
        const ioFiber = yield* Effect.forkScoped(
          Stream.runForEach(ioStream, (event) =>
            emitWatchOutput(input.onEvent, toWatchIoOutput(event)),
          ),
        );

        yield* Stream.runForEach(
          Stream.takeUntil(eventStream, (event) => isRunTerminalEvent(event.type)),
          (event) => emitWatchOutput(input.onEvent, toWatchEventOutput(event)),
        );

        yield* Fiber.interrupt(ioFiber);
      }),
    ),
  );
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
