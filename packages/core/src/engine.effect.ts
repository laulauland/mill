import { Cause, Clock, Data, Effect, Exit, Ref, Stream } from "effect";
import {
  makeEventEnvelope,
  type MillEvent,
  type TaskCompleteEvent,
  type TaskMessageChunkEvent,
  type TaskMilestoneEvent,
  type TaskPlanEvent,
  type TaskStartEvent,
  type TaskThoughtChunkEvent,
  type TaskToolCallEvent,
} from "./event.schema";
import {
  decodeTaskIdSync,
  type RunId,
  type RunResult,
  type RunSyncOutput,
  type TaskId,
} from "./run.schema";
import { type TaskOptions, type TaskResult as TaskStorageResult } from "./task.schema";
import type {
  AgentRuntimeEvent,
  AgentTurnOutput,
  DriverRuntime,
  ExtensionContext,
  ExtensionRegistration,
  TaskInput,
  TaskResult,
} from "./types";
import {
  LifecycleInvariantError,
  applyLifecycleTransition,
  initialLifecycleGuardState,
  isRunTerminalEvent,
  type LifecycleGuardState,
} from "./lifecycle-guard.effect";
import {
  PersistenceError,
  RunNotFoundError,
  makeRunStore,
  type RunStore,
} from "./run-store.effect";
import {
  publishIoEvent,
  publishTier1Event,
  watchIoLive,
  watchTier1GlobalLive,
  watchTier1Live,
  type IoStreamEvent,
} from "./observer-hub.effect";

export class ConfigError extends Data.TaggedError("ConfigError")<{ message: string }> {}

export class ProgramExecutionError extends Data.TaggedError("ProgramExecutionError")<{
  runId: string;
  message: string;
}> {}

export class WaitTimeoutError extends Data.TaggedError("WaitTimeoutError")<{
  runId: string;
  timeoutMillis: number;
  message: string;
}> {}

export interface RunSubmitInput {
  readonly runId: RunId;
  readonly programPath: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface RunSyncInput extends RunSubmitInput {
  readonly executeProgram: (
    task: (
      input: TaskInput,
    ) => Effect.Effect<
      TaskResult,
      ProgramExecutionError | PersistenceError | LifecycleInvariantError
    >,
  ) => Effect.Effect<unknown, ProgramExecutionError>;
}

export interface InspectRef {
  readonly runId: RunId;
  readonly taskId?: TaskId;
}

export type InspectResult =
  | {
      readonly kind: "run";
      readonly run: RunSyncOutput["run"];
      readonly events: ReadonlyArray<MillEvent>;
      readonly result: RunResult | undefined;
    }
  | {
      readonly kind: "task";
      readonly runId: RunId;
      readonly taskId: TaskId;
      readonly events: ReadonlyArray<MillEvent>;
      readonly result: TaskStorageResult | undefined;
    };

export interface CancelResult {
  readonly run: RunSyncOutput["run"];
  readonly alreadyTerminal: boolean;
}

export interface MillEngine {
  readonly submit: (input: RunSubmitInput) => Effect.Effect<RunSyncOutput["run"], PersistenceError>;
  readonly runSync: (
    input: RunSyncInput,
  ) => Effect.Effect<
    RunSyncOutput,
    ConfigError | PersistenceError | ProgramExecutionError | LifecycleInvariantError
  >;
  readonly status: (
    runId: RunId,
  ) => Effect.Effect<RunSyncOutput["run"], RunNotFoundError | PersistenceError>;
  readonly result: (
    runId: RunId,
  ) => Effect.Effect<RunResult | undefined, RunNotFoundError | PersistenceError>;
  readonly wait: (
    runId: RunId,
    timeout: number | string,
  ) => Effect.Effect<
    RunSyncOutput["run"],
    RunNotFoundError | PersistenceError | LifecycleInvariantError | WaitTimeoutError
  >;
  readonly list: (
    status?: RunSyncOutput["run"]["status"],
  ) => Effect.Effect<ReadonlyArray<RunSyncOutput["run"]>, PersistenceError>;
  readonly watch: (runId: RunId) => Stream.Stream<MillEvent, RunNotFoundError | PersistenceError>;
  readonly watchAll: (sinceTimeIso?: string) => Stream.Stream<MillEvent, PersistenceError>;
  readonly watchIo: (
    runId: RunId,
  ) => Stream.Stream<IoStreamEvent, RunNotFoundError | PersistenceError>;
  readonly inspect: (
    ref: InspectRef,
  ) => Effect.Effect<InspectResult, RunNotFoundError | PersistenceError>;
  readonly cancel: (
    runId: RunId,
    reason?: string,
  ) => Effect.Effect<CancelResult, RunNotFoundError | PersistenceError | LifecycleInvariantError>;
}

export interface MakeMillEngineInput {
  readonly runsDirectory: string;
  readonly driverName: string;
  readonly executorName: string;
  readonly driver: DriverRuntime;
  readonly extensions: ReadonlyArray<ExtensionRegistration>;
}

const toIsoTimestamp = Effect.map(Clock.currentTimeMillis, (millis) =>
  new Date(millis).toISOString(),
);

const toMessage = (error: unknown): string => String(error);

const normalizePath = (path: string): string => {
  if (path.length <= 1) {
    return path;
  }

  return path.endsWith("/") ? path.slice(0, -1) : path;
};

const joinPath = (base: string, child: string): string =>
  normalizePath(base) === "/" ? `/${child}` : `${normalizePath(base)}/${child}`;

const nextSequence = (sequenceRef: Ref.Ref<number>): Effect.Effect<number> =>
  Ref.updateAndGet(sequenceRef, (current) => current + 1);

const toPersistenceError = (
  runId: RunId,
  error: RunNotFoundError | PersistenceError,
): PersistenceError => {
  if (error._tag === "PersistenceError") {
    return error;
  }

  return new PersistenceError({
    path: runId,
    message: `Run ${runId} not found while appending event.`,
  });
};

const synchronizeAppendState = (
  lifecycleStateRef: Ref.Ref<LifecycleGuardState>,
  sequenceRef: Ref.Ref<number>,
  runStore: RunStore,
  runId: RunId,
): Effect.Effect<LifecycleGuardState, PersistenceError | LifecycleInvariantError> =>
  Effect.gen(function* () {
    const persistedEvents = yield* Effect.mapError(runStore.readEvents(runId), (error) =>
      toPersistenceError(runId, error),
    );

    let lifecycleState = initialLifecycleGuardState;

    for (const persistedEvent of persistedEvents) {
      lifecycleState = yield* applyLifecycleTransition(lifecycleState, persistedEvent);
    }

    const maxPersistedSequence = persistedEvents.reduce(
      (currentMax, event) => (event.sequence > currentMax ? event.sequence : currentMax),
      0,
    );

    yield* Ref.set(lifecycleStateRef, lifecycleState);
    yield* Ref.set(sequenceRef, maxPersistedSequence);

    return lifecycleState;
  });

const appendTier1Event = (
  lifecycleStateRef: Ref.Ref<LifecycleGuardState>,
  sequenceRef: Ref.Ref<number>,
  runStore: RunStore,
  runId: RunId,
  eventBuilder: (sequence: number, timestamp: string) => MillEvent,
): Effect.Effect<void, PersistenceError | LifecycleInvariantError> =>
  Effect.gen(function* () {
    const synchronizedState = yield* synchronizeAppendState(
      lifecycleStateRef,
      sequenceRef,
      runStore,
      runId,
    );
    const sequence = yield* nextSequence(sequenceRef);
    const timestamp = yield* toIsoTimestamp;
    const event = eventBuilder(sequence, timestamp);
    const nextState = yield* applyLifecycleTransition(synchronizedState, event);

    yield* Ref.set(lifecycleStateRef, nextState);
    yield* runStore.appendEvent(runId, event);
    yield* publishTier1Event(runId, event);
  });

const appendExtensionErrorEvent = (
  lifecycleStateRef: Ref.Ref<LifecycleGuardState>,
  sequenceRef: Ref.Ref<number>,
  runStore: RunStore,
  runId: RunId,
  extensionName: string,
  hook: "setup" | "onEvent",
  message: string,
): Effect.Effect<void, PersistenceError | LifecycleInvariantError> =>
  appendTier1Event(lifecycleStateRef, sequenceRef, runStore, runId, (sequence, timestamp) => ({
    ...makeEventEnvelope(runId, sequence, timestamp),
    type: "extension:error",
    payload: {
      extensionName,
      hook,
      message,
    },
  }));

const notifyExtensionHookFailures = (
  lifecycleStateRef: Ref.Ref<LifecycleGuardState>,
  sequenceRef: Ref.Ref<number>,
  runStore: RunStore,
  runId: RunId,
  extensionName: string,
  hook: "setup" | "onEvent",
  message: string,
): Effect.Effect<void, never> =>
  Effect.catch(
    appendExtensionErrorEvent(
      lifecycleStateRef,
      sequenceRef,
      runStore,
      runId,
      extensionName,
      hook,
      message,
    ),
    () => Effect.void,
  );

const runExtensionSetupHooks = (
  extensions: ReadonlyArray<ExtensionRegistration>,
  extensionContext: ExtensionContext,
  lifecycleStateRef: Ref.Ref<LifecycleGuardState>,
  sequenceRef: Ref.Ref<number>,
  runStore: RunStore,
  runId: RunId,
): Effect.Effect<void, PersistenceError | LifecycleInvariantError> =>
  Effect.gen(function* () {
    for (const extension of extensions) {
      if (extension.setup === undefined) {
        continue;
      }

      const setupExit = yield* Effect.exit(extension.setup(extensionContext));

      if (Exit.isFailure(setupExit)) {
        yield* notifyExtensionHookFailures(
          lifecycleStateRef,
          sequenceRef,
          runStore,
          runId,
          extension.name,
          "setup",
          Cause.pretty(setupExit.cause),
        );
      }
    }
  });

const runExtensionOnEventHooks = (
  extensions: ReadonlyArray<ExtensionRegistration>,
  extensionContext: ExtensionContext,
  lifecycleStateRef: Ref.Ref<LifecycleGuardState>,
  sequenceRef: Ref.Ref<number>,
  runStore: RunStore,
  runId: RunId,
  event: MillEvent,
): Effect.Effect<void, PersistenceError | LifecycleInvariantError> =>
  Effect.gen(function* () {
    if (event.type === "extension:error") {
      return;
    }

    for (const extension of extensions) {
      if (extension.onEvent === undefined) {
        continue;
      }

      const hookExit = yield* Effect.exit(extension.onEvent(event, extensionContext));

      if (Exit.isFailure(hookExit)) {
        yield* notifyExtensionHookFailures(
          lifecycleStateRef,
          sequenceRef,
          runStore,
          runId,
          extension.name,
          "onEvent",
          Cause.pretty(hookExit.cause),
        );
      }
    }
  });

const appendTier1EventWithHooks = (
  extensions: ReadonlyArray<ExtensionRegistration>,
  extensionContext: ExtensionContext,
  lifecycleStateRef: Ref.Ref<LifecycleGuardState>,
  sequenceRef: Ref.Ref<number>,
  runStore: RunStore,
  runId: RunId,
  eventBuilder: (sequence: number, timestamp: string) => MillEvent,
): Effect.Effect<void, PersistenceError | LifecycleInvariantError> =>
  Effect.gen(function* () {
    const synchronizedState = yield* synchronizeAppendState(
      lifecycleStateRef,
      sequenceRef,
      runStore,
      runId,
    );
    const sequence = yield* nextSequence(sequenceRef);
    const timestamp = yield* toIsoTimestamp;
    const event = eventBuilder(sequence, timestamp);
    const nextState = yield* applyLifecycleTransition(synchronizedState, event);

    yield* Ref.set(lifecycleStateRef, nextState);
    yield* runStore.appendEvent(runId, event);
    yield* publishTier1Event(runId, event);
    yield* runExtensionOnEventHooks(
      extensions,
      extensionContext,
      lifecycleStateRef,
      sequenceRef,
      runStore,
      runId,
      event,
    );
  });

const toTimeoutMillis = (timeout: number | string): number => {
  if (typeof timeout === "number") {
    return timeout;
  }

  const parsed = Number.parseFloat(timeout);

  if (Number.isNaN(parsed)) {
    return 0;
  }

  if (timeout.includes("second")) {
    return Math.max(0, Math.round(parsed * 1000));
  }

  return Math.max(0, Math.round(parsed));
};

const isRunTerminalStatus = (status: RunSyncOutput["run"]["status"]): boolean =>
  status === "complete" || status === "failed" || status === "cancelled";

const isSinceTimeIso = (value: string): boolean => {
  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    return false;
  }

  return new Date(parsed).toISOString() === value;
};

const isEventAtOrAfter = (event: MillEvent, sinceTimeIso: string | undefined): boolean => {
  if (sinceTimeIso === undefined) {
    return true;
  }

  return event.timestamp >= sinceTimeIso;
};

const compareMillEvents = (left: MillEvent, right: MillEvent): number => {
  const byTime = left.timestamp.localeCompare(right.timestamp);

  if (byTime !== 0) {
    return byTime;
  }

  const byRun = left.runId.localeCompare(right.runId);

  if (byRun !== 0) {
    return byRun;
  }

  return left.sequence - right.sequence;
};

const waitForRunTerminal = (
  runStore: RunStore,
  runId: RunId,
): Effect.Effect<
  RunSyncOutput["run"],
  RunNotFoundError | PersistenceError | LifecycleInvariantError
> =>
  Effect.gen(function* () {
    // Check if run is already terminal before entering polling loop
    const initialRun = yield* runStore.getRun(runId);

    if (isRunTerminalStatus(initialRun.status)) {
      return initialRun;
    }

    let observedEvents = 0;
    let terminalObserved = false;
    let lifecycleState = initialLifecycleGuardState;

    while (true) {
      const events = yield* runStore.readEvents(runId);

      for (let index = observedEvents; index < events.length; index += 1) {
        const event = events[index];

        lifecycleState = yield* applyLifecycleTransition(lifecycleState, event);
        observedEvents = index + 1;

        if (isRunTerminalEvent(event)) {
          terminalObserved = true;
        }
      }

      if (terminalObserved) {
        const currentRun = yield* runStore.getRun(runId);

        if (isRunTerminalStatus(currentRun.status)) {
          return currentRun;
        }
      }

      yield* Effect.sleep("25 millis");
    }
  });

const appendTaskErrorEvent = (
  extensions: ReadonlyArray<ExtensionRegistration>,
  extensionContext: ExtensionContext,
  lifecycleStateRef: Ref.Ref<LifecycleGuardState>,
  sequenceRef: Ref.Ref<number>,
  runStore: RunStore,
  runId: RunId,
  taskId: string,
  message: string,
): Effect.Effect<void, PersistenceError | LifecycleInvariantError> =>
  appendTier1EventWithHooks(
    extensions,
    extensionContext,
    lifecycleStateRef,
    sequenceRef,
    runStore,
    runId,
    (sequence, timestamp) => ({
      ...makeEventEnvelope(runId, sequence, timestamp),
      type: "task:error",
      payload: {
        taskId: decodeTaskIdSync(taskId),
        message,
      },
    }),
  );

const terminalEventForRun = (event: MillEvent): boolean =>
  event.type === "run:complete" || event.type === "run:failed" || event.type === "run:cancelled";

const isTaskEventForTask = (event: MillEvent, taskId: TaskId): boolean => {
  if (event.type === "task:start") {
    return event.payload.taskId === taskId;
  }

  if (event.type === "task:milestone") {
    return event.payload.taskId === taskId;
  }

  if (event.type === "task:tool_call") {
    return event.payload.taskId === taskId;
  }

  if (event.type === "task:message_chunk") {
    return event.payload.taskId === taskId;
  }

  if (event.type === "task:thought_chunk") {
    return event.payload.taskId === taskId;
  }

  if (event.type === "task:plan") {
    return event.payload.taskId === taskId;
  }

  if (event.type === "task:error") {
    return event.payload.taskId === taskId;
  }

  if (event.type === "task:complete") {
    return event.payload.taskId === taskId;
  }

  if (event.type === "task:cancelled") {
    return event.payload.taskId === taskId;
  }

  return false;
};

const taskResultFromEvents = (
  events: ReadonlyArray<MillEvent>,
  taskId: TaskId,
): TaskStorageResult | undefined => {
  const completion = events.find(
    (event): event is Extract<MillEvent, { type: "task:complete" }> =>
      event.type === "task:complete" && event.payload.taskId === taskId,
  );

  if (completion === undefined) {
    return undefined;
  }

  return completion.payload.result;
};

const DefaultTaskSystemPrompt = "You are a helpful coding agent.";

const taskInputToStorageTaskOptions = (taskInput: TaskInput): TaskOptions => ({
  role: taskInput.role ?? taskInput.agent.driver,
  system: taskInput.system ?? DefaultTaskSystemPrompt,
  prompt: taskInput.prompt,
  model: taskInput.agent.model,
  driver: taskInput.agent.driver,
});

const storageTaskResultFromTaskResult = (result: TaskResult): TaskStorageResult => ({
  text: result.text,
  sessionRef: result.sessionRef,
  role: result.role,
  model: result.model,
  driver: result.driver,
  exitCode: result.exitCode,
  stopReason: result.stopReason,
  errorMessage: result.errorMessage,
});

const taskResultFromTaskTurnOutput = (output: AgentTurnOutput): TaskResult => ({
  text: output.result.text,
  sessionRef: output.result.sessionRef,
  role: output.result.role,
  model: output.result.model,
  driver: output.result.driver,
  exitCode: output.result.exitCode,
  stopReason: output.result.stopReason,
  errorMessage: output.result.errorMessage,
});

export const makeMillEngine = (input: MakeMillEngineInput): MillEngine => {
  const runStore = makeRunStore({
    runsDirectory: input.runsDirectory,
  });

  return {
    submit: (submitInput) =>
      Effect.gen(function* () {
        const existingRun = yield* Effect.catchTag(
          runStore.getRun(submitInput.runId),
          "RunNotFoundError",
          () => Effect.succeed(undefined),
        );

        if (existingRun !== undefined) {
          return existingRun;
        }

        const submittedAt = yield* toIsoTimestamp;

        return yield* runStore.create({
          runId: submitInput.runId,
          programPath: submitInput.programPath,
          driver: input.driverName,
          executor: input.executorName,
          timestamp: submittedAt,
          status: "pending",
          metadata: submitInput.metadata,
        });
      }),

    runSync: (runInput) =>
      Effect.gen(function* () {
        const existingRun = yield* Effect.catchTag(
          runStore.getRun(runInput.runId),
          "RunNotFoundError",
          () => Effect.succeed(undefined),
        );

        let activeRun = existingRun;

        if (activeRun === undefined) {
          const startedAt = yield* toIsoTimestamp;

          activeRun = yield* runStore.create({
            runId: runInput.runId,
            programPath: runInput.programPath,
            driver: input.driverName,
            executor: input.executorName,
            timestamp: startedAt,
            status: "running",
            metadata: runInput.metadata,
          });
        }

        if (isRunTerminalStatus(activeRun.status)) {
          const existingResult = yield* runStore.getResult(runInput.runId);

          if (existingResult !== undefined) {
            return {
              run: activeRun,
              result: existingResult,
            } satisfies RunSyncOutput;
          }

          return yield* Effect.fail(
            new ProgramExecutionError({
              runId: runInput.runId,
              message: `Run ${runInput.runId} is terminal (${activeRun.status}) but result.json is missing.`,
            }),
          );
        }

        if (activeRun.status === "pending") {
          const runningAt = yield* toIsoTimestamp;
          activeRun = yield* runStore.setStatus(runInput.runId, "running", runningAt);
        }

        const existingEvents = yield* runStore.readEvents(runInput.runId);

        let lifecycleState = initialLifecycleGuardState;

        for (const event of existingEvents) {
          lifecycleState = yield* applyLifecycleTransition(lifecycleState, event);
        }

        const existingTaskCount = existingEvents.filter(
          (event) => event.type === "task:start",
        ).length;
        const existingTaskStorageResults = existingEvents
          .filter(
            (event): event is Extract<MillEvent, { type: "task:complete" }> =>
              event.type === "task:complete",
          )
          .map((event) => event.payload.result);

        const maxSequence = existingEvents.reduce(
          (currentMax, event) => (event.sequence > currentMax ? event.sequence : currentMax),
          0,
        );

        const lifecycleStateRef = yield* Ref.make(lifecycleState);
        const sequenceRef = yield* Ref.make(maxSequence);
        const taskCounterRef = yield* Ref.make(existingTaskCount);
        const taskResultsRef = yield* Ref.make<ReadonlyArray<TaskStorageResult>>(
          existingTaskStorageResults,
        );
        const extensionContext: ExtensionContext = {
          runId: runInput.runId,
          driverName: input.driverName,
          executorName: input.executorName,
        };

        const publishDriverRawLines = (
          taskId: TaskId,
          rawLines: ReadonlyArray<string> | undefined,
        ): Effect.Effect<void> =>
          Effect.gen(function* () {
            for (const rawLine of rawLines ?? []) {
              const timestamp = yield* toIsoTimestamp;

              yield* publishIoEvent({
                runId: runInput.runId,
                source: "driver",
                stream: "stdout",
                line: rawLine,
                timestamp,
                taskId,
              });
            }
          });

        const appendDriverEvents = (
          taskId: TaskId,
          driverEvents: ReadonlyArray<AgentRuntimeEvent>,
        ): Effect.Effect<void, PersistenceError | LifecycleInvariantError> =>
          Effect.gen(function* () {
            for (const driverEvent of driverEvents) {
              if (driverEvent.type === "milestone") {
                const milestoneEvent: Omit<
                  TaskMilestoneEvent,
                  "schemaVersion" | "runId" | "sequence" | "timestamp"
                > = {
                  type: "task:milestone",
                  payload: {
                    taskId,
                    message: driverEvent.message,
                  },
                };

                yield* appendTier1EventWithHooks(
                  input.extensions,
                  extensionContext,
                  lifecycleStateRef,
                  sequenceRef,
                  runStore,
                  runInput.runId,
                  (sequence, timestamp) => ({
                    ...makeEventEnvelope(runInput.runId, sequence, timestamp),
                    ...milestoneEvent,
                  }),
                );
              }

              if (driverEvent.type === "tool_call") {
                const toolCallEvent: Omit<
                  TaskToolCallEvent,
                  "schemaVersion" | "runId" | "sequence" | "timestamp"
                > = {
                  type: "task:tool_call",
                  payload: {
                    taskId,
                    toolName: driverEvent.toolName,
                  },
                };

                yield* appendTier1EventWithHooks(
                  input.extensions,
                  extensionContext,
                  lifecycleStateRef,
                  sequenceRef,
                  runStore,
                  runInput.runId,
                  (sequence, timestamp) => ({
                    ...makeEventEnvelope(runInput.runId, sequence, timestamp),
                    ...toolCallEvent,
                  }),
                );
              }

              if (driverEvent.type === "message_chunk") {
                const messageChunkEvent: Omit<
                  TaskMessageChunkEvent,
                  "schemaVersion" | "runId" | "sequence" | "timestamp"
                > = {
                  type: "task:message_chunk",
                  payload: {
                    taskId,
                    text: driverEvent.text,
                  },
                };

                yield* appendTier1EventWithHooks(
                  input.extensions,
                  extensionContext,
                  lifecycleStateRef,
                  sequenceRef,
                  runStore,
                  runInput.runId,
                  (sequence, timestamp) => ({
                    ...makeEventEnvelope(runInput.runId, sequence, timestamp),
                    ...messageChunkEvent,
                  }),
                );
              }

              if (driverEvent.type === "thought_chunk") {
                const thoughtChunkEvent: Omit<
                  TaskThoughtChunkEvent,
                  "schemaVersion" | "runId" | "sequence" | "timestamp"
                > = {
                  type: "task:thought_chunk",
                  payload: {
                    taskId,
                    text: driverEvent.text,
                  },
                };

                yield* appendTier1EventWithHooks(
                  input.extensions,
                  extensionContext,
                  lifecycleStateRef,
                  sequenceRef,
                  runStore,
                  runInput.runId,
                  (sequence, timestamp) => ({
                    ...makeEventEnvelope(runInput.runId, sequence, timestamp),
                    ...thoughtChunkEvent,
                  }),
                );
              }

              if (driverEvent.type === "plan") {
                const planEvent: Omit<
                  TaskPlanEvent,
                  "schemaVersion" | "runId" | "sequence" | "timestamp"
                > = {
                  type: "task:plan",
                  payload: {
                    taskId,
                    steps: driverEvent.steps,
                  },
                };

                yield* appendTier1EventWithHooks(
                  input.extensions,
                  extensionContext,
                  lifecycleStateRef,
                  sequenceRef,
                  runStore,
                  runInput.runId,
                  (sequence, timestamp) => ({
                    ...makeEventEnvelope(runInput.runId, sequence, timestamp),
                    ...planEvent,
                  }),
                );
              }
            }
          });

        if (existingEvents.length === 0) {
          yield* runExtensionSetupHooks(
            input.extensions,
            extensionContext,
            lifecycleStateRef,
            sequenceRef,
            runStore,
            runInput.runId,
          );

          yield* appendTier1EventWithHooks(
            input.extensions,
            extensionContext,
            lifecycleStateRef,
            sequenceRef,
            runStore,
            runInput.runId,
            (sequence, timestamp) => ({
              ...makeEventEnvelope(runInput.runId, sequence, timestamp),
              type: "run:start",
              payload: {
                programPath: runInput.programPath,
              },
            }),
          );

          yield* appendTier1EventWithHooks(
            input.extensions,
            extensionContext,
            lifecycleStateRef,
            sequenceRef,
            runStore,
            runInput.runId,
            (sequence, timestamp) => ({
              ...makeEventEnvelope(runInput.runId, sequence, timestamp),
              type: "run:status",
              payload: {
                status: "running",
              },
            }),
          );
        }

        const task = (
          taskInput: TaskInput,
        ): Effect.Effect<
          TaskResult,
          ProgramExecutionError | PersistenceError | LifecycleInvariantError
        > =>
          Effect.gen(function* () {
            const storageInput = taskInputToStorageTaskOptions(taskInput);

            const nextTaskCounter = yield* Ref.updateAndGet(
              taskCounterRef,
              (counter) => counter + 1,
            );
            const taskId = decodeTaskIdSync(`task_${nextTaskCounter}`);

            const taskStartEvent: Omit<
              TaskStartEvent,
              "schemaVersion" | "runId" | "sequence" | "timestamp"
            > = {
              type: "task:start",
              payload: {
                taskId,
                input: storageInput,
              },
            };

            yield* appendTier1EventWithHooks(
              input.extensions,
              extensionContext,
              lifecycleStateRef,
              sequenceRef,
              runStore,
              runInput.runId,
              (sequence, timestamp) => ({
                ...makeEventEnvelope(runInput.runId, sequence, timestamp),
                ...taskStartEvent,
              }),
            );

            yield* Effect.logDebug("mill.engine:task-session-start", {
              runId: runInput.runId,
              taskId,
              driver: input.driver.name,
              role: storageInput.role,
              model: storageInput.model,
            });

            const driverOutputExit = yield* Effect.exit(
              Effect.gen(function* () {
                const session = yield* input.driver.createSession({
                  runId: runInput.runId,
                  runDirectory: joinPath(input.runsDirectory, runInput.runId),
                  taskId,
                  role: storageInput.role,
                  system: storageInput.system,
                  model: storageInput.model,
                });

                return yield* session
                  .startTurn({ prompt: storageInput.prompt })
                  .pipe(Effect.ensuring(session.close()));
              }).pipe(
                Effect.mapError(
                  (error) =>
                    new ProgramExecutionError({
                      runId: runInput.runId,
                      message: `Driver ${input.driver.name} task session failed: ${toMessage(error)}`,
                    }),
                ),
              ),
            );

            if (Exit.isFailure(driverOutputExit)) {
              const failureMessage = Cause.pretty(driverOutputExit.cause);

              yield* Effect.logDebug("mill.engine:task-session-failed", {
                runId: runInput.runId,
                taskId,
                driver: input.driver.name,
                message: failureMessage,
              });

              yield* appendTaskErrorEvent(
                input.extensions,
                extensionContext,
                lifecycleStateRef,
                sequenceRef,
                runStore,
                runInput.runId,
                taskId,
                failureMessage,
              );

              return yield* Effect.fail(
                new ProgramExecutionError({
                  runId: runInput.runId,
                  message: failureMessage,
                }),
              );
            }

            yield* publishDriverRawLines(taskId, driverOutputExit.value.raw);
            yield* appendDriverEvents(taskId, driverOutputExit.value.events);

            const taskResult = taskResultFromTaskTurnOutput(driverOutputExit.value);
            const storageResult = storageTaskResultFromTaskResult(taskResult);
            const taskCompleteEvent: Omit<
              TaskCompleteEvent,
              "schemaVersion" | "runId" | "sequence" | "timestamp"
            > = {
              type: "task:complete",
              payload: {
                taskId,
                result: storageResult,
              },
            };

            yield* appendTier1EventWithHooks(
              input.extensions,
              extensionContext,
              lifecycleStateRef,
              sequenceRef,
              runStore,
              runInput.runId,
              (sequence, timestamp) => ({
                ...makeEventEnvelope(runInput.runId, sequence, timestamp),
                ...taskCompleteEvent,
              }),
            );

            yield* Ref.update(taskResultsRef, (items) => [...items, storageResult]);

            yield* Effect.logDebug("mill.engine:task-complete", {
              runId: runInput.runId,
              taskId,
              role: taskResult.role,
              model: taskResult.model,
              sessionRef: taskResult.sessionRef,
              exitCode: taskResult.exitCode,
            });

            return taskResult;
          });

        const executionExit = yield* Effect.exit(runInput.executeProgram(task));
        const completedAt = yield* toIsoTimestamp;
        const taskResults = yield* Ref.get(taskResultsRef);
        const startedAt = activeRun.createdAt;

        if (Exit.isSuccess(executionExit)) {
          const runResult: RunResult = {
            runId: runInput.runId,
            status: "complete",
            startedAt,
            completedAt,
            tasks: taskResults,
            programResult:
              typeof executionExit.value === "string"
                ? executionExit.value
                : JSON.stringify(executionExit.value),
          };

          yield* appendTier1EventWithHooks(
            input.extensions,
            extensionContext,
            lifecycleStateRef,
            sequenceRef,
            runStore,
            runInput.runId,
            (sequence, timestamp) => ({
              ...makeEventEnvelope(runInput.runId, sequence, timestamp),
              type: "run:complete",
              payload: {
                result: runResult,
              },
            }),
          );

          yield* runStore.setResult(runInput.runId, runResult, completedAt);

          const completedRun = yield* runStore.getRun(runInput.runId);

          return {
            run: completedRun,
            result: runResult,
          } satisfies RunSyncOutput;
        }

        const failureMessage = Cause.pretty(executionExit.cause);
        const failedResult: RunResult = {
          runId: runInput.runId,
          status: "failed",
          startedAt,
          completedAt,
          tasks: taskResults,
          errorMessage: failureMessage,
        };

        yield* appendTier1EventWithHooks(
          input.extensions,
          extensionContext,
          lifecycleStateRef,
          sequenceRef,
          runStore,
          runInput.runId,
          (sequence, timestamp) => ({
            ...makeEventEnvelope(runInput.runId, sequence, timestamp),
            type: "run:failed",
            payload: {
              message: failureMessage,
            },
          }),
        );

        yield* runStore.setResult(runInput.runId, failedResult, completedAt);

        return yield* Effect.fail(
          new ProgramExecutionError({
            runId: runInput.runId,
            message: failureMessage,
          }),
        );
      }),

    status: (runId) => runStore.getRun(runId),

    result: (runId) => runStore.getResult(runId),

    wait: (runId, timeout) => {
      const timeoutMillis = toTimeoutMillis(timeout);

      return waitForRunTerminal(runStore, runId).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMillis,
          orElse: () =>
            Effect.fail(
              new WaitTimeoutError({
                runId,
                timeoutMillis,
                message: `Timed out waiting for terminal event for run ${runId} after ${timeoutMillis}ms.`,
              }),
            ),
        }),
      );
    },

    list: (status) => runStore.listRuns(status),

    watch: (runId) =>
      Stream.unwrap(
        Effect.map(runStore.readEvents(runId), (persistedEvents) =>
          Stream.concat(Stream.fromIterable(persistedEvents), watchTier1Live(runId)),
        ),
      ),

    watchAll: (sinceTimeIso) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (sinceTimeIso !== undefined && !isSinceTimeIso(sinceTimeIso)) {
            return Stream.fail(
              new PersistenceError({
                path: "watch.since-time",
                message: `Invalid --since-time value '${sinceTimeIso}'. Expected ISO timestamp.`,
              }),
            );
          }

          const runs = yield* runStore.listRuns();
          const eventsByRun = yield* Effect.forEach(runs, (run) => runStore.readEvents(run.id), {
            concurrency: "unbounded",
          });

          const persistedEvents = eventsByRun
            .flat()
            .filter((event) => isEventAtOrAfter(event, sinceTimeIso))
            .sort(compareMillEvents);

          const persistedStream = Stream.fromIterable(persistedEvents);
          const liveStream = Stream.filter(watchTier1GlobalLive(), (event) =>
            isEventAtOrAfter(event, sinceTimeIso),
          );

          return Stream.concat(persistedStream, liveStream);
        }),
      ),

    watchIo: (runId) =>
      Stream.unwrap(Effect.andThen(runStore.getRun(runId), Effect.succeed(watchIoLive(runId)))),

    inspect: (ref) =>
      Effect.gen(function* () {
        const run = yield* runStore.getRun(ref.runId);
        const events = yield* runStore.readEvents(ref.runId);

        if (ref.taskId === undefined) {
          const result = yield* runStore.getResult(ref.runId);

          return {
            kind: "run",
            run,
            events,
            result,
          } satisfies InspectResult;
        }

        const taskEvents = events.filter((event) => isTaskEventForTask(event, ref.taskId));

        return {
          kind: "task",
          runId: ref.runId,
          taskId: ref.taskId,
          events: taskEvents,
          result: taskResultFromEvents(events, ref.taskId),
        } satisfies InspectResult;
      }),

    cancel: (runId, reason) =>
      Effect.gen(function* () {
        const run = yield* runStore.getRun(runId);

        yield* Effect.logDebug("mill.engine:cancel-requested", {
          runId,
          status: run.status,
          reason,
        });

        if (isRunTerminalStatus(run.status)) {
          yield* Effect.logDebug("mill.engine:cancel-noop-terminal", {
            runId,
            status: run.status,
          });

          return {
            run,
            alreadyTerminal: true,
          } satisfies CancelResult;
        }

        const events = yield* runStore.readEvents(runId);
        const alreadyTerminalEvent = events.some(terminalEventForRun);

        if (!alreadyTerminalEvent) {
          let lifecycleState = initialLifecycleGuardState;

          for (const event of events) {
            lifecycleState = yield* applyLifecycleTransition(lifecycleState, event);
          }

          const maxSequence = events.reduce(
            (currentMax, event) => (event.sequence > currentMax ? event.sequence : currentMax),
            0,
          );

          const lifecycleStateRef = yield* Ref.make(lifecycleState);
          const sequenceRef = yield* Ref.make(maxSequence);

          yield* Effect.catchTag(
            appendTier1Event(
              lifecycleStateRef,
              sequenceRef,
              runStore,
              runId,
              (sequence, timestamp) => ({
                ...makeEventEnvelope(runId, sequence, timestamp),
                type: "run:cancelled",
                payload: {
                  reason,
                },
              }),
            ),
            "LifecycleInvariantError",
            () => Effect.void,
          );
        }

        const cancelledAt = yield* toIsoTimestamp;
        const cancelledRun = yield* Effect.catchTag(
          runStore.setStatus(runId, "cancelled", cancelledAt),
          "LifecycleInvariantError",
          () => runStore.getRun(runId),
        );

        yield* Effect.logDebug("mill.engine:cancelled", {
          runId,
          status: cancelledRun.status,
        });

        return {
          run: cancelledRun,
          alreadyTerminal: false,
        } satisfies CancelResult;
      }),
  };
};
