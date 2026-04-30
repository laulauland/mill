import {
  cancelRun,
  getRunStatus,
  listRuns,
  runProgramSync,
  runWorker,
  submitRun,
  waitForRun,
  watchRun,
  type CancelRunInput,
  type LaunchWorkerInput,
  type ListRunsInput,
  type RunProgramSyncInput,
  type RunWorkerInput,
  type SubmitRunInput,
  type WaitForRunInput,
  type RunRecord,
  type RunSyncOutput,
  type WatchRunInput,
} from "./run.api";
import type { ResolveConfigOptions } from "./types";

interface MillRuntimeBaseOptions extends ResolveConfigOptions {
  readonly runsDirectory?: string;
  readonly driverName?: string;
  readonly executorName?: string;
}

export interface MillRuntimeOptions extends MillRuntimeBaseOptions {
  readonly launchWorker?: (input: LaunchWorkerInput) => Promise<void>;
}

export interface MillRuntimeRunInput {
  readonly programPath: string;
  readonly sync?: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly waitTimeoutSeconds?: number;
}

export interface MillRuntimeWorkerInput {
  readonly runId: string;
  readonly programPath: string;
  readonly runDepth?: number;
}

export interface MillRuntimeWaitInput {
  readonly timeoutSeconds: number;
}

export interface MillRuntimeWatchInput {
  readonly channel?: WatchRunInput["channel"];
  readonly source?: WatchRunInput["source"];
  readonly taskId?: string;
  readonly sinceTimeIso?: string;
  readonly onEvent: (line: string) => void;
}

export interface MillRuntimeListInput {
  readonly status?: ListRunsInput["status"];
}

export interface MillRuntimeRunActor {
  readonly done: Promise<RunRecord | RunSyncOutput>;
  readonly start: () => MillRuntimeRunActor;
  readonly getSnapshot: () => RunRecord | undefined;
}

export interface MillRuntimeRunRef {
  readonly id: string;
  readonly getSnapshot: () => Promise<RunRecord>;
  readonly wait: (input: MillRuntimeWaitInput) => Promise<RunRecord>;
  readonly watch: (input: MillRuntimeWatchInput) => Promise<void>;
  readonly cancel: (reason?: string) => Promise<{
    readonly runId: string;
    readonly status: RunRecord["status"];
    readonly alreadyTerminal: boolean;
  }>;
}

export interface MillRuntime {
  readonly run: (input: MillRuntimeRunInput) => MillRuntimeRunActor;
  readonly worker: (input: MillRuntimeWorkerInput) => Promise<RunSyncOutput>;
  readonly runRef: (runId: string) => MillRuntimeRunRef;
  readonly watch: (input: MillRuntimeWatchInput) => Promise<void>;
  readonly list: (input?: MillRuntimeListInput) => Promise<ReadonlyArray<RunRecord>>;
}

const mergeRunInput = (
  options: MillRuntimeOptions,
  input: MillRuntimeRunInput,
): SubmitRunInput & RunProgramSyncInput => ({
  ...options,
  programPath: input.programPath,
  launchWorker:
    options.launchWorker ??
    (() => Promise.reject(new Error("Mill runtime launchWorker is required for run()."))),
  metadata: input.metadata,
  waitTimeoutSeconds: input.waitTimeoutSeconds,
});

const mergeRunRefInput = (
  options: MillRuntimeOptions,
  runId: string,
): Omit<WaitForRunInput & CancelRunInput & WatchRunInput, "timeoutSeconds" | "onEvent"> => ({
  ...options,
  runId,
});

export const createMillRuntime = (options: MillRuntimeOptions): MillRuntime => {
  const run = (input: MillRuntimeRunInput): MillRuntimeRunActor => {
    let snapshot: RunRecord | undefined;
    let started = false;
    const runInput = mergeRunInput(options, input);
    let resolveDone: (output: RunRecord | RunSyncOutput) => void = () => undefined;
    let rejectDone: (error: unknown) => void = () => undefined;
    const done = new Promise<RunRecord | RunSyncOutput>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const startRun = async (): Promise<void> => {
      try {
        const output =
          input.sync === true ? await runProgramSync(runInput) : await submitRun(runInput);
        snapshot = "run" in output ? output.run : output;
        resolveDone(output);
      } catch (error) {
        rejectDone(error);
      }
    };

    const actor: MillRuntimeRunActor = {
      done,
      start: () => {
        if (!started) {
          started = true;
          void startRun();
        }

        return actor;
      },
      getSnapshot: () => snapshot,
    };

    return actor;
  };

  const runRef = (runId: string): MillRuntimeRunRef => ({
    id: runId,
    getSnapshot: () => getRunStatus({ ...mergeRunRefInput(options, runId) }),
    wait: (input) =>
      waitForRun({
        ...mergeRunRefInput(options, runId),
        timeoutSeconds: input.timeoutSeconds,
      }),
    watch: (input) =>
      watchRun({
        ...mergeRunRefInput(options, runId),
        channel: input.channel,
        source: input.source,
        taskId: input.taskId,
        sinceTimeIso: input.sinceTimeIso,
        onEvent: input.onEvent,
      }),
    cancel: (reason) => cancelRun({ ...mergeRunRefInput(options, runId), reason }),
  });

  return {
    run,
    worker: (input) =>
      runWorker({
        ...options,
        runId: input.runId,
        programPath: input.programPath,
        runDepth: input.runDepth,
      } satisfies RunWorkerInput),
    runRef,
    watch: (input) =>
      watchRun({
        ...options,
        channel: input.channel,
        source: input.source,
        taskId: input.taskId,
        sinceTimeIso: input.sinceTimeIso,
        onEvent: input.onEvent,
      }),
    list: (input) => listRuns({ ...options, status: input?.status }),
  };
};
