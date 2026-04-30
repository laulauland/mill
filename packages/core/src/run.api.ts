import * as FileSystem from "effect/FileSystem";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Cause, Data, Effect, Exit, Fiber, Stream } from "effect";
import { makeMillEngine, ProgramExecutionError, WaitTimeoutError } from "./engine.effect";
import { type MillEvent } from "./event.schema";
import { decodeRunIdSync, type RunRecord, type RunSyncOutput } from "./run.schema";
import { runDetachedWorker } from "./worker.effect";
import { executeProgramInProcessHost } from "./program-host.effect";
import { publishIoEvent, type IoStreamEvent } from "./observer-hub.effect";
import {
  appendTextFile,
  ensureDirectory,
  randomUuid,
  readProcessCommand,
  readProcessTable,
  readTextFile,
  removePath,
  writeTextFile,
} from "./run-platform.adapter";
import type { AgentRuntime, ExtensionRegistration } from "./types";
export type { RunRecord, RunSyncOutput } from "./run.schema";

export type ProcessSignal = "SIGTERM" | "SIGKILL";

export class ProcessControlError extends Data.TaggedError("ProcessControlError")<{
  readonly operation: "isAlive" | "sendSignal";
  readonly pid: number;
  readonly signal?: ProcessSignal;
  readonly cause: unknown;
}> {}

export interface ProcessControl {
  readonly isAlive: (pid: number) => Effect.Effect<boolean, ProcessControlError>;
  readonly sendSignal: (
    pid: number,
    signal: ProcessSignal,
  ) => Effect.Effect<boolean, ProcessControlError>;
}

interface BaseRunInput {
  readonly cwd?: string;
  readonly homeDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly runsDirectory?: string;
  readonly maxRunDepth?: number;
  readonly agentRuntimes: Readonly<Record<string, AgentRuntime>>;
  readonly extensions?: ReadonlyArray<ExtensionRegistration>;
  readonly executablePath?: string;
  readonly processControl?: ProcessControl;
}

export interface SubmitRunInput extends BaseRunInput {
  readonly programPath: string;
  readonly launchWorker: (input: LaunchWorkerInput) => Promise<void>;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface RunProgramSyncInput extends SubmitRunInput {
  readonly waitTimeoutSeconds?: number;
}

interface GetRunStatusInput extends BaseRunInput {
  readonly runId: string;
}

export interface WaitForRunInput {
  readonly runId: string;
  readonly timeoutSeconds: number;
  readonly homeDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly runsDirectory?: string;
}

export type WatchChannel = "events" | "io" | "all";
export type WatchSource = "agent" | "program";

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
      readonly taskId?: string;
    };

export interface WatchRunInput extends Omit<GetRunStatusInput, "runId"> {
  readonly runId?: string;
  readonly channel?: WatchChannel;
  readonly source?: WatchSource;
  readonly taskId?: string;
  readonly sinceTimeIso?: string;
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
  readonly workerPid?: number;
}

export interface LaunchWorkerInput {
  readonly runId: string;
  readonly programPath: string;
  readonly runsDirectory: string;
  readonly cwd: string;
  readonly runDepth: number;
}

interface EngineContext {
  readonly engine: ReturnType<typeof makeMillEngine>;
  readonly runsDirectory: string;
  readonly maxRunDepth: number;
}

class RunApiError extends Data.TaggedError("RunApiError")<{ message: string }> {}

class LaunchWorkerError extends Data.TaggedError("LaunchWorkerError")<{
  readonly runId: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

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

const sleepEffect = (millis: number): Effect.Effect<void> => Effect.sleep(`${millis} millis`);

const runDirectoryFor = (runsDirectory: string, runId: string): string =>
  joinPath(runsDirectory, runId);

const workerPidPathFor = (runDirectory: string): string =>
  joinPath(runDirectory, WORKER_PID_FILENAME);

const appendCancelLog = (
  runDirectory: string,
  message: string,
): Effect.Effect<void, never, FileSystem.FileSystem> => {
  const logPath = joinPath(runDirectory, CANCEL_LOG_PATH);
  const logDirectory = logPath.slice(0, logPath.lastIndexOf("/"));
  const timestamp = new Date().toISOString();

  return Effect.andThen(
    ensureDirectory(logDirectory),
    appendTextFile(logPath, `${timestamp} ${message}\n`),
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning("mill.cancel-log:write-failed", { runDirectory, logPath, message, error }),
    ),
  );
};

const readWorkerPid = (
  runDirectory: string,
): Effect.Effect<number | undefined, never, FileSystem.FileSystem> =>
  readTextFile(workerPidPathFor(runDirectory)).pipe(
    Effect.map((raw) => {
      const trimmed = raw.trim();
      const parsed = Number.parseInt(trimmed, 10);

      if (!Number.isInteger(parsed) || parsed <= 0) {
        return undefined;
      }

      return parsed;
    }),
    Effect.catch((error) =>
      Effect.as(
        Effect.logDebug("mill.worker-pid:read-missing-or-invalid", { runDirectory, error }),
        undefined,
      ),
    ),
  );

const removeWorkerPidFile = (
  runDirectory: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  removePath(workerPidPathFor(runDirectory)).pipe(
    Effect.catch((error) =>
      Effect.logWarning("mill.worker-pid:remove-failed", { runDirectory, error }),
    ),
  );

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

const looksLikeMillWorkerCommand = (commandLine: string, runId: string): boolean => {
  if (!commandLine.includes("_worker")) {
    return false;
  }

  return commandLine.includes(`--run-id ${runId}`);
};

const countSignals = (
  processControl: ProcessControl,
  targets: ReadonlyArray<number>,
  signal: ProcessSignal,
): Effect.Effect<number> =>
  Effect.map(
    Effect.forEach(
      targets,
      (pid) =>
        processControl
          .sendSignal(pid, signal)
          .pipe(
            Effect.catch((error) =>
              Effect.as(
                Effect.logDebug("mill.process:send-signal-failed", { pid, signal, error }),
                false,
              ),
            ),
          ),
      { concurrency: "unbounded" },
    ),
    (results) => results.filter(Boolean).length,
  );

const liveProcesses = (
  processControl: ProcessControl,
  targets: ReadonlyArray<number>,
): Effect.Effect<ReadonlyArray<number>> =>
  Effect.map(
    Effect.forEach(targets, (pid) =>
      processControl.isAlive(pid).pipe(
        Effect.catch((error) =>
          Effect.as(Effect.logDebug("mill.process:is-alive-failed", { pid, error }), false),
        ),
        Effect.map((alive) => ({ pid, alive })),
      ),
    ),
    (results) => results.filter((result) => result.alive).map((result) => result.pid),
  );

const terminateWorkerProcessTree = (
  runsDirectory: string,
  runId: string,
  processControl: ProcessControl | undefined,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const runDirectory = runDirectoryFor(runsDirectory, runId);

    if (processControl === undefined) {
      yield* appendCancelLog(
        runDirectory,
        `cancel:kill skipped run=${runId} reason=no-process-control`,
      );
      return;
    }

    const workerPid = yield* readWorkerPid(runDirectory);

    if (workerPid === undefined) {
      yield* appendCancelLog(runDirectory, `cancel:kill skipped run=${runId} reason=no-worker-pid`);
      return;
    }

    const commandInspection = yield* readProcessCommand(workerPid).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.as(
            Effect.zipRight(
              Effect.logWarning("mill.cancel:read-worker-command-failed", {
                runId,
                pid: workerPid,
                error,
              }),
              appendCancelLog(
                runDirectory,
                `cancel:kill skipped run=${runId} pid=${workerPid} reason=command-inspection-failed`,
              ),
            ),
            { _tag: "inspection-failed" as const },
          ),
        onSuccess: (commandLine) =>
          Effect.succeed(
            commandLine === undefined
              ? { _tag: "missing" as const }
              : { _tag: "found" as const, commandLine },
          ),
      }),
    );

    if (commandInspection._tag === "inspection-failed") {
      return;
    }

    if (commandInspection._tag === "missing") {
      yield* appendCancelLog(
        runDirectory,
        `cancel:kill stale-pid run=${runId} pid=${workerPid} reason=command-missing`,
      );
      yield* removeWorkerPidFile(runDirectory);
      return;
    }

    if (!looksLikeMillWorkerCommand(commandInspection.commandLine, runId)) {
      yield* appendCancelLog(
        runDirectory,
        `cancel:kill skipped run=${runId} pid=${workerPid} reason=pid-mismatch command=${commandInspection.commandLine}`,
      );
      return;
    }

    const table = yield* readProcessTable().pipe(
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning("mill.cancel:read-process-table-failed", { runId, error }),
          [] as ReadonlyArray<{ pid: number; ppid: number }>,
        ),
      ),
    );
    const descendants = descendantsFor(workerPid, table);
    const targets = [...new Set([...descendants, workerPid])];
    const termCount = yield* countSignals(processControl, targets, "SIGTERM");

    yield* appendCancelLog(
      runDirectory,
      `cancel:kill term-sent run=${runId} pid=${workerPid} targets=${targets.length} signaled=${termCount}`,
    );

    yield* sleepEffect(PROCESS_EXIT_GRACE_MILLIS);

    const survivors = yield* liveProcesses(processControl, targets);
    const killCount = yield* countSignals(processControl, survivors, "SIGKILL");

    yield* appendCancelLog(
      runDirectory,
      `cancel:kill kill-sent run=${runId} pid=${workerPid} survivors=${survivors.length} signaled=${killCount}`,
    );

    const workerAlive = yield* processControl
      .isAlive(workerPid)
      .pipe(
        Effect.catch((error) =>
          Effect.as(
            Effect.logDebug("mill.process:is-alive-failed", { pid: workerPid, error }),
            false,
          ),
        ),
      );
    if (!workerAlive) {
      yield* removeWorkerPidFile(runDirectory);
    }
  });

const resolveProgramPath = (cwd: string, programPath: string): string =>
  programPath.startsWith("/") ? normalizePath(programPath) : joinPath(cwd, programPath);

const resolveRunsDirectoryEffect = (
  homeDirectory: string | undefined,
  runsDirectory: string | undefined,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (runsDirectory !== undefined && runsDirectory.length > 0) {
      return runsDirectory;
    }

    const resolvedHomeDirectory = homeDirectory?.trim();

    if (resolvedHomeDirectory === undefined || resolvedHomeDirectory.length === 0) {
      return yield* Effect.fail(
        new RunApiError({ message: "Unable to resolve runs directory because HOME is unset." }),
      );
    }

    return joinPath(resolvedHomeDirectory, ".mill/runs");
  });

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

const resolveCurrentRunDepth = (
  env: Readonly<Record<string, string | undefined>> | undefined,
): number => {
  const parsed = parseInteger(env?.[RUN_DEPTH_ENV]);

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

export const runWithBunServices = <A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, BunServices.layer));

const readProgramSource = (
  programPath: string,
): Effect.Effect<string, unknown, BunServices.BunServices> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(programPath, "utf-8");
  });

const writeSubmissionArtifacts = (
  run: RunRecord,
  programSource: string,
): Effect.Effect<void, unknown, BunServices.BunServices> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const copiedProgramPath = joinPath(run.paths.runDir, "program.ts");
    const logsDirectory = joinPath(run.paths.runDir, "logs");
    const workerLogPath = joinPath(logsDirectory, "worker.log");

    yield* fileSystem.writeFileString(copiedProgramPath, programSource);
    yield* fileSystem.makeDirectory(logsDirectory, { recursive: true });
    yield* fileSystem.writeFileString(workerLogPath, "");
  });

const makeEngineForInputEffect = (input: BaseRunInput): Effect.Effect<EngineContext, unknown> =>
  Effect.gen(function* () {
    const runsDirectory = yield* resolveRunsDirectoryEffect(
      input.homeDirectory ?? input.env?.HOME,
      input.runsDirectory,
    );

    return {
      runsDirectory,
      maxRunDepth: resolveMaxRunDepth(input.maxRunDepth),
      engine: makeMillEngine({
        runsDirectory,
        agentRuntimes: input.agentRuntimes,
        extensions: input.extensions ?? [],
      }),
    };
  });

const makeWaitEngineEffect = (
  input: WaitForRunInput,
): Effect.Effect<Pick<EngineContext, "engine">, unknown> =>
  Effect.gen(function* () {
    const runsDirectory = yield* resolveRunsDirectoryEffect(
      input.homeDirectory ?? input.env?.HOME,
      input.runsDirectory,
    );

    return {
      engine: makeMillEngine({
        runsDirectory,
        agentRuntimes: {},
        extensions: [],
      }),
    };
  });

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
  taskId: event.taskId,
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
  taskId: string | undefined,
): boolean => {
  if (source !== undefined && event.source !== source) {
    return false;
  }

  if (taskId !== undefined && event.taskId !== taskId) {
    return false;
  }

  return true;
};

export const submitRunEffect = (
  input: SubmitRunInput,
): Effect.Effect<RunRecord, unknown, BunServices.BunServices> =>
  Effect.gen(function* () {
    const cwd = input.cwd ?? ".";
    const programPath = resolveProgramPath(cwd, input.programPath);
    const programSource = yield* readProgramSource(programPath);
    const engineContext = yield* makeEngineForInputEffect(input);
    const generatedRunId = yield* randomUuid();
    const runId = decodeRunIdSync(`run_${generatedRunId}`);

    const currentRunDepth = resolveCurrentRunDepth(input.env);
    const nextRunDepth = currentRunDepth + 1;

    if (nextRunDepth > engineContext.maxRunDepth) {
      return yield* Effect.fail(
        new RunApiError({
          message: `Run depth ${nextRunDepth} exceeds configured maxRunDepth=${engineContext.maxRunDepth}.`,
        }),
      );
    }

    yield* ensureDirectory(engineContext.runsDirectory);

    const submittedRun = yield* engineContext.engine.submit({
      runId,
      programPath,
      metadata: input.metadata,
    });

    yield* writeSubmissionArtifacts(submittedRun, programSource);

    const copiedProgramPath = joinPath(submittedRun.paths.runDir, "program.ts");

    yield* Effect.tryPromise({
      try: () =>
        input.launchWorker({
          runId: submittedRun.id,
          programPath: copiedProgramPath,
          runsDirectory: engineContext.runsDirectory,
          cwd,
          runDepth: nextRunDepth,
        }),
      catch: (cause) =>
        new LaunchWorkerError({
          runId: submittedRun.id,
          message: `Failed to launch worker for run ${submittedRun.id}.`,
          cause,
        }),
    });

    return submittedRun;
  });

export const submitRun = (input: SubmitRunInput): Promise<RunRecord> =>
  runWithBunServices(submitRunEffect(input));

export const runProgramSyncEffect = (
  input: RunProgramSyncInput,
): Effect.Effect<RunSyncOutput, unknown, BunServices.BunServices> =>
  Effect.gen(function* () {
    const submittedRun = yield* submitRunEffect(input);
    const timeoutSeconds = input.waitTimeoutSeconds ?? DEFAULT_SYNC_WAIT_TIMEOUT_SECONDS;

    const terminalRun = yield* waitForRunEffect({
      runId: submittedRun.id,
      timeoutSeconds,
      homeDirectory: input.homeDirectory,
      env: input.env,
      runsDirectory: input.runsDirectory,
    });

    const engineContext = yield* makeEngineForInputEffect(input);
    const result = yield* engineContext.engine.result(decodeRunIdSync(submittedRun.id));

    if (result === undefined) {
      return yield* Effect.fail(
        new RunApiError({ message: `Run ${submittedRun.id} completed without persisted result.` }),
      );
    }

    return {
      run: terminalRun,
      result,
    };
  });

export const runProgramSync = (input: RunProgramSyncInput): Promise<RunSyncOutput> =>
  runWithBunServices(runProgramSyncEffect(input));

const runWorkerEffect = (
  input: RunWorkerInput,
): Effect.Effect<RunSyncOutput, unknown, BunServices.BunServices> =>
  Effect.gen(function* () {
    const cwd = input.cwd ?? ".";
    const programPath = resolveProgramPath(cwd, input.programPath);
    const programSource = yield* readProgramSource(programPath);
    const engineContext = yield* makeEngineForInputEffect(input);
    const runDirectory = runDirectoryFor(engineContext.runsDirectory, input.runId);
    const workerPidPath = workerPidPathFor(runDirectory);
    const runDepth = input.runDepth ?? resolveCurrentRunDepth(input.env);

    yield* ensureDirectory(runDirectory);
    if (input.workerPid !== undefined) {
      yield* writeTextFile(workerPidPath, `${input.workerPid}\n`);
    }

    return yield* Effect.ensuring(
      runDetachedWorker({
        engine: engineContext.engine,
        runId: decodeRunIdSync(input.runId),
        programPath,
        runsDirectory: engineContext.runsDirectory,
        executeProgram: (task) =>
          Effect.mapError(
            executeProgramInProcessHost({
              runId: input.runId,
              runDirectory: joinPath(engineContext.runsDirectory, input.runId),
              workingDirectory: cwd,
              programPath,
              programSource,
              executablePath: input.executablePath,
              extensions: input.extensions ?? [],
              env: {
                ...input.env,
                [RUN_DEPTH_ENV]: String(runDepth),
              },
              task,
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
            (error) =>
              new ProgramExecutionError({
                runId: input.runId,
                message: String(error),
              }),
          ),
      }),
      removeWorkerPidFile(runDirectory),
    );
  });

export const runWorker = (input: RunWorkerInput): Promise<RunSyncOutput> =>
  runWithBunServices(runWorkerEffect(input));

const getRunStatusEffect = (
  input: GetRunStatusInput,
): Effect.Effect<RunRecord, unknown, BunServices.BunServices> =>
  Effect.gen(function* () {
    const engineContext = yield* makeEngineForInputEffect(input);
    return yield* engineContext.engine.status(decodeRunIdSync(input.runId));
  });

export const getRunStatus = (input: GetRunStatusInput): Promise<RunRecord> =>
  runWithBunServices(getRunStatusEffect(input));

const isWaitTimeoutError = (error: unknown): error is WaitTimeoutError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "WaitTimeoutError";

const findWaitTimeoutError = (cause: Cause.Cause<unknown>): WaitTimeoutError | undefined => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && isWaitTimeoutError(reason.error)) {
      return reason.error;
    }
  }

  return undefined;
};

const waitForRunEffect = (
  input: WaitForRunInput,
): Effect.Effect<RunRecord, unknown, BunServices.BunServices> =>
  Effect.gen(function* () {
    const engineContext = yield* makeWaitEngineEffect(input);
    const waitOutcome = yield* Effect.exit(
      engineContext.engine.wait(
        decodeRunIdSync(input.runId),
        Math.round(input.timeoutSeconds * 1000),
      ),
    );

    if (Exit.isSuccess(waitOutcome)) {
      return waitOutcome.value;
    }

    const timeoutError = findWaitTimeoutError(waitOutcome.cause);

    if (timeoutError !== undefined) {
      return yield* Effect.fail(timeoutError);
    }

    return yield* Effect.fail(new RunApiError({ message: Cause.pretty(waitOutcome.cause) }));
  });

export const waitForRun = (input: WaitForRunInput): Promise<RunRecord> =>
  runWithBunServices(waitForRunEffect(input));

const watchRunEffect = (
  input: WatchRunInput,
): Effect.Effect<void, unknown, BunServices.BunServices> =>
  Effect.gen(function* () {
    if (input.sinceTimeIso !== undefined && !isSinceTimeIso(input.sinceTimeIso)) {
      return yield* Effect.fail(
        new RunApiError({
          message: `Invalid --since-time value '${input.sinceTimeIso}'. Expected ISO timestamp.`,
        }),
      );
    }

    const channel = input.channel ?? "events";

    if (input.runId === undefined && channel !== "events") {
      return yield* Effect.fail(
        new RunApiError({ message: "watch --channel io|all requires --run <runId>." }),
      );
    }

    if (input.runId === undefined && (input.source !== undefined || input.taskId !== undefined)) {
      return yield* Effect.fail(
        new RunApiError({ message: "watch --source/--task requires --run <runId>." }),
      );
    }

    if (channel === "io" && input.sinceTimeIso !== undefined) {
      return yield* Effect.fail(
        new RunApiError({ message: "watch --channel io does not support --since-time." }),
      );
    }

    if (channel === "events" && (input.source !== undefined || input.taskId !== undefined)) {
      return yield* Effect.fail(
        new RunApiError({
          message: "watch --source/--task require --channel io or --channel all.",
        }),
      );
    }

    const engineContext = yield* makeEngineForInputEffect(input);

    if (input.runId === undefined) {
      return yield* Effect.scoped(
        Stream.runForEach(engineContext.engine.watchAll(input.sinceTimeIso), (event) =>
          emitWatchOutput(input.onEvent, toWatchEventOutput(event)),
        ),
      );
    }

    const runId = decodeRunIdSync(input.runId);

    const eventStream = Stream.filter(engineContext.engine.watch(runId), (event) =>
      input.sinceTimeIso === undefined ? true : event.timestamp >= input.sinceTimeIso,
    );

    const ioStream = Stream.filter(engineContext.engine.watchIo(runId), (event) =>
      filterIoEvent(event, input.source, input.taskId),
    );

    if (channel === "events") {
      return yield* Effect.scoped(
        Stream.runForEach(
          Stream.takeUntil(eventStream, (event) => isRunTerminalEvent(event.type)),
          (event) => emitWatchOutput(input.onEvent, toWatchEventOutput(event)),
        ),
      );
    }

    const currentRun = yield* engineContext.engine.status(runId);

    if (
      currentRun.status === "complete" ||
      currentRun.status === "failed" ||
      currentRun.status === "cancelled"
    ) {
      if (channel === "all") {
        return yield* Effect.scoped(
          Stream.runForEach(
            Stream.takeUntil(eventStream, (event) => isRunTerminalEvent(event.type)),
            (event) => emitWatchOutput(input.onEvent, toWatchEventOutput(event)),
          ),
        );
      }

      return;
    }

    if (channel === "io") {
      return yield* Effect.raceFirst(
        Effect.scoped(
          Stream.runForEach(ioStream, (event) =>
            emitWatchOutput(input.onEvent, toWatchIoOutput(event)),
          ),
        ),
        engineContext.engine.wait(runId, DEFAULT_SYNC_WAIT_TIMEOUT_SECONDS * 1000),
      );
    }

    return yield* Effect.scoped(
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
    );
  });

export const watchRun = (input: WatchRunInput): Promise<void> =>
  runWithBunServices(watchRunEffect(input));

const cancelRunEffect = (
  input: CancelRunInput,
): Effect.Effect<
  {
    runId: string;
    status: RunRecord["status"];
    alreadyTerminal: boolean;
  },
  unknown,
  BunServices.BunServices
> =>
  Effect.gen(function* () {
    const engineContext = yield* makeEngineForInputEffect(input);
    const cancelled = yield* engineContext.engine.cancel(
      decodeRunIdSync(input.runId),
      input.reason,
    );

    yield* terminateWorkerProcessTree(
      engineContext.runsDirectory,
      input.runId,
      input.processControl,
    );

    return {
      runId: cancelled.run.id,
      status: cancelled.run.status,
      alreadyTerminal: cancelled.alreadyTerminal,
    };
  });

export const cancelRun = (
  input: CancelRunInput,
): Promise<{
  runId: string;
  status: RunRecord["status"];
  alreadyTerminal: boolean;
}> => runWithBunServices(cancelRunEffect(input));

const listRunsEffect = (
  input: ListRunsInput,
): Effect.Effect<ReadonlyArray<RunRecord>, unknown, BunServices.BunServices> =>
  Effect.gen(function* () {
    const engineContext = yield* makeEngineForInputEffect(input);
    return yield* engineContext.engine.list(input.status);
  });

export const listRuns = (input: ListRunsInput): Promise<ReadonlyArray<RunRecord>> =>
  runWithBunServices(listRunsEffect(input));
