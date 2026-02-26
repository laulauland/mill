import { Cause, Clock, Data, Effect, Exit, Ref, Stream } from "effect";
import {
  makeEventEnvelope,
  type MillEvent,
  type SpawnCompleteEvent,
  type SpawnMilestoneEvent,
  type SpawnStartEvent,
  type SpawnToolCallEvent,
} from "../domain/event.schema";
import {
  decodeSpawnIdSync,
  type RunId,
  type RunResult,
  type RunSyncOutput,
  type SpawnId,
} from "../domain/run.schema";
import { decodeSpawnResult, type SpawnOptions, type SpawnResult } from "../domain/spawn.schema";
import type { DriverRuntime, ExtensionContext, ExtensionRegistration } from "../public/types";
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
    spawn: (
      input: SpawnOptions,
    ) => Effect.Effect<
      SpawnResult,
      ProgramExecutionError | PersistenceError | LifecycleInvariantError
    >,
  ) => Effect.Effect<unknown, ProgramExecutionError>;
}

export interface InspectRef {
  readonly runId: RunId;
  readonly spawnId?: SpawnId;
}

export type InspectResult =
  | {
      readonly kind: "run";
      readonly run: RunSyncOutput["run"];
      readonly events: ReadonlyArray<MillEvent>;
      readonly result: RunResult | undefined;
    }
  | {
      readonly kind: "spawn";
      readonly runId: RunId;
      readonly spawnId: SpawnId;
      readonly events: ReadonlyArray<MillEvent>;
      readonly result: SpawnResult | undefined;
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
  readonly defaultModel: string;
  readonly driver: DriverRuntime;
  readonly extensions: ReadonlyArray<ExtensionRegistration>;
}

const toIsoTimestamp = Effect.map(Clock.currentTimeMillis, (millis) =>
  new Date(millis).toISOString(),
);

const toMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

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
  Effect.catchAll(
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

const appendSpawnErrorEvent = (
  extensions: ReadonlyArray<ExtensionRegistration>,
  extensionContext: ExtensionContext,
  lifecycleStateRef: Ref.Ref<LifecycleGuardState>,
  sequenceRef: Ref.Ref<number>,
  runStore: RunStore,
  runId: RunId,
  spawnId: string,
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
      type: "spawn:error",
      payload: {
        spawnId: decodeSpawnIdSync(spawnId),
        message,
      },
    }),
  );

const terminalEventForRun = (event: MillEvent): boolean =>
  event.type === "run:complete" || event.type === "run:failed" || event.type === "run:cancelled";

const isSpawnEventForSpawn = (event: MillEvent, spawnId: SpawnId): boolean => {
  if (event.type === "spawn:start") {
    return event.payload.spawnId === spawnId;
  }

  if (event.type === "spawn:milestone") {
    return event.payload.spawnId === spawnId;
  }

  if (event.type === "spawn:tool_call") {
    return event.payload.spawnId === spawnId;
  }

  if (event.type === "spawn:error") {
    return event.payload.spawnId === spawnId;
  }

  if (event.type === "spawn:complete") {
    return event.payload.spawnId === spawnId;
  }

  if (event.type === "spawn:cancelled") {
    return event.payload.spawnId === spawnId;
  }

  return false;
};

const spawnResultFromEvents = (
  events: ReadonlyArray<MillEvent>,
  spawnId: SpawnId,
): SpawnResult | undefined => {
  const completion = events.find(
    (event): event is Extract<MillEvent, { type: "spawn:complete" }> =>
      event.type === "spawn:complete" && event.payload.spawnId === spawnId,
  );

  if (completion === undefined) {
    return undefined;
  }

  return completion.payload.result;
};

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

        const existingSpawnCount = existingEvents.filter(
          (event) => event.type === "spawn:start",
        ).length;
        const existingSpawnResults = existingEvents
          .filter(
            (event): event is Extract<MillEvent, { type: "spawn:complete" }> =>
              event.type === "spawn:complete",
          )
          .map((event) => event.payload.result);

        const maxSequence = existingEvents.reduce(
          (currentMax, event) => (event.sequence > currentMax ? event.sequence : currentMax),
          0,
        );

        const lifecycleStateRef = yield* Ref.make(lifecycleState);
        const sequenceRef = yield* Ref.make(maxSequence);
        const spawnCounterRef = yield* Ref.make(existingSpawnCount);
        const spawnResultsRef = yield* Ref.make<ReadonlyArray<SpawnResult>>(existingSpawnResults);
        const extensionContext: ExtensionContext = {
          runId: runInput.runId,
          driverName: input.driverName,
          executorName: input.executorName,
        };

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

        const spawn = (
          spawnInput: SpawnOptions,
        ): Effect.Effect<
          SpawnResult,
          ProgramExecutionError | PersistenceError | LifecycleInvariantError
        > =>
          Effect.gen(function* () {
            const nextSpawnCounter = yield* Ref.updateAndGet(
              spawnCounterRef,
              (counter) => counter + 1,
            );
            const spawnId = decodeSpawnIdSync(`spawn_${nextSpawnCounter}`);

            const spawnStartEvent: Omit<
              SpawnStartEvent,
              "schemaVersion" | "runId" | "sequence" | "timestamp"
            > = {
              type: "spawn:start",
              payload: {
                spawnId,
                input: spawnInput,
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
                ...spawnStartEvent,
              }),
            );

            yield* Effect.logDebug("mill.engine:spawn-driver-start", {
              runId: runInput.runId,
              spawnId,
              driver: input.driver.name,
              agent: spawnInput.agent,
              model: spawnInput.model ?? input.defaultModel,
            });

            const driverOutputExit = yield* Effect.exit(
              Effect.mapError(
                input.driver.spawn({
                  runId: runInput.runId,
                  runDirectory: joinPath(input.runsDirectory, runInput.runId),
                  spawnId,
                  agent: spawnInput.agent,
                  systemPrompt: spawnInput.systemPrompt,
                  prompt: spawnInput.prompt,
                  model: spawnInput.model ?? input.defaultModel,
                }),
                (error) =>
                  new ProgramExecutionError({
                    runId: runInput.runId,
                    message: `Driver ${input.driver.name} failed: ${toMessage(error)}`,
                  }),
              ),
            );

            if (Exit.isFailure(driverOutputExit)) {
              const failureMessage = Cause.pretty(driverOutputExit.cause);

              yield* Effect.logDebug("mill.engine:spawn-driver-failed", {
                runId: runInput.runId,
                spawnId,
                driver: input.driver.name,
                message: failureMessage,
              });

              yield* appendSpawnErrorEvent(
                input.extensions,
                extensionContext,
                lifecycleStateRef,
                sequenceRef,
                runStore,
                runInput.runId,
                spawnId,
                failureMessage,
              );

              return yield* Effect.fail(
                new ProgramExecutionError({
                  runId: runInput.runId,
                  message: failureMessage,
                }),
              );
            }

            yield* Effect.logDebug("mill.engine:spawn-driver-complete", {
              runId: runInput.runId,
              spawnId,
              driver: input.driver.name,
              rawLines: driverOutputExit.value.raw?.length ?? 0,
              events: driverOutputExit.value.events.length,
            });

            for (const rawLine of driverOutputExit.value.raw ?? []) {
              const timestamp = yield* toIsoTimestamp;

              yield* publishIoEvent({
                runId: runInput.runId,
                source: "driver",
                stream: "stdout",
                line: rawLine,
                timestamp,
                spawnId,
              });
            }

            for (const driverEvent of driverOutputExit.value.events) {
              if (driverEvent.type === "milestone") {
                const milestoneEvent: Omit<
                  SpawnMilestoneEvent,
                  "schemaVersion" | "runId" | "sequence" | "timestamp"
                > = {
                  type: "spawn:milestone",
                  payload: {
                    spawnId,
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
                  SpawnToolCallEvent,
                  "schemaVersion" | "runId" | "sequence" | "timestamp"
                > = {
                  type: "spawn:tool_call",
                  payload: {
                    spawnId,
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
            }

            const spawnResultExit = yield* Effect.exit(
              Effect.mapError(
                decodeSpawnResult(driverOutputExit.value.result),
                (error) =>
                  new ProgramExecutionError({
                    runId: runInput.runId,
                    message: `Spawn result decode failed: ${toMessage(error)}`,
                  }),
              ),
            );

            if (Exit.isFailure(spawnResultExit)) {
              const failureMessage = Cause.pretty(spawnResultExit.cause);

              yield* appendSpawnErrorEvent(
                input.extensions,
                extensionContext,
                lifecycleStateRef,
                sequenceRef,
                runStore,
                runInput.runId,
                spawnId,
                failureMessage,
              );

              return yield* Effect.fail(
                new ProgramExecutionError({
                  runId: runInput.runId,
                  message: failureMessage,
                }),
              );
            }

            const spawnResult = spawnResultExit.value;
            const spawnCompleteEvent: Omit<
              SpawnCompleteEvent,
              "schemaVersion" | "runId" | "sequence" | "timestamp"
            > = {
              type: "spawn:complete",
              payload: {
                spawnId,
                result: spawnResult,
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
                ...spawnCompleteEvent,
              }),
            );

            yield* Ref.update(spawnResultsRef, (items) => [...items, spawnResult]);

            yield* Effect.logDebug("mill.engine:spawn-complete", {
              runId: runInput.runId,
              spawnId,
              agent: spawnResult.agent,
              model: spawnResult.model,
              sessionRef: spawnResult.sessionRef,
              exitCode: spawnResult.exitCode,
            });

            return spawnResult;
          });

        const executionExit = yield* Effect.exit(runInput.executeProgram(spawn));
        const completedAt = yield* toIsoTimestamp;
        const spawnResults = yield* Ref.get(spawnResultsRef);
        const startedAt = activeRun.createdAt;

        if (Exit.isSuccess(executionExit)) {
          const runResult: RunResult = {
            runId: runInput.runId,
            status: "complete",
            startedAt,
            completedAt,
            spawns: spawnResults,
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
          spawns: spawnResults,
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
        Effect.timeoutFail({
          duration: timeoutMillis,
          onTimeout: () =>
            new WaitTimeoutError({
              runId,
              timeoutMillis,
              message: `Timed out waiting for terminal event for run ${runId} after ${timeoutMillis}ms.`,
            }),
        }),
      );
    },

    list: (status) => runStore.listRuns(status),

    watch: (runId) =>
      Stream.unwrapScoped(
        Effect.map(runStore.readEvents(runId), (persistedEvents) =>
          Stream.concat(Stream.fromIterable(persistedEvents), watchTier1Live(runId)),
        ),
      ),

    watchAll: (sinceTimeIso) =>
      Stream.unwrapScoped(
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
      Stream.unwrapScoped(
        Effect.zipRight(runStore.getRun(runId), Effect.succeed(watchIoLive(runId))),
      ),

    inspect: (ref) =>
      Effect.gen(function* () {
        const run = yield* runStore.getRun(ref.runId);
        const events = yield* runStore.readEvents(ref.runId);

        if (ref.spawnId === undefined) {
          const result = yield* runStore.getResult(ref.runId);

          return {
            kind: "run",
            run,
            events,
            result,
          } satisfies InspectResult;
        }

        const spawnEvents = events.filter((event) => isSpawnEventForSpawn(event, ref.spawnId));

        return {
          kind: "spawn",
          runId: ref.runId,
          spawnId: ref.spawnId,
          events: spawnEvents,
          result: spawnResultFromEvents(events, ref.spawnId),
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
