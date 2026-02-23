import { Cause, Clock, Data, Effect, Exit, Ref } from "effect";
import {
  makeEventEnvelope,
  type MillEvent,
  type SpawnCompleteEvent,
  type SpawnErrorEvent,
  type SpawnMilestoneEvent,
  type SpawnStartEvent,
  type SpawnToolCallEvent,
} from "../domain/event.schema";
import {
  decodeSpawnIdSync,
  type RunId,
  type RunResult,
  type RunSyncOutput,
} from "../domain/run.schema";
import { decodeSpawnResult, type SpawnOptions, type SpawnResult } from "../domain/spawn.schema";
import type { DriverRuntime } from "../public/types";
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

export interface RunSyncInput {
  readonly runId: RunId;
  readonly programPath: string;
  readonly executeProgram: (
    spawn: (
      input: SpawnOptions,
    ) => Effect.Effect<
      SpawnResult,
      ProgramExecutionError | PersistenceError | LifecycleInvariantError
    >,
  ) => Effect.Effect<unknown, ProgramExecutionError>;
}

export interface MillEngine {
  readonly runSync: (
    input: RunSyncInput,
  ) => Effect.Effect<
    RunSyncOutput,
    ConfigError | PersistenceError | ProgramExecutionError | LifecycleInvariantError
  >;
  readonly status: (
    runId: RunId,
  ) => Effect.Effect<RunSyncOutput["run"], RunNotFoundError | PersistenceError>;
  readonly wait: (
    runId: RunId,
    timeout: number | string,
  ) => Effect.Effect<
    RunSyncOutput["run"],
    RunNotFoundError | PersistenceError | LifecycleInvariantError | WaitTimeoutError
  >;
}

export interface MakeMillEngineInput {
  readonly runsDirectory: string;
  readonly driverName: string;
  readonly defaultModel: string;
  readonly driver: DriverRuntime;
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

const nextSequence = (sequenceRef: Ref.Ref<number>): Effect.Effect<number> =>
  Ref.updateAndGet(sequenceRef, (current) => current + 1);

const appendTier1Event = (
  lifecycleStateRef: Ref.Ref<LifecycleGuardState>,
  sequenceRef: Ref.Ref<number>,
  runStore: RunStore,
  runId: RunId,
  eventBuilder: (sequence: number, timestamp: string) => MillEvent,
): Effect.Effect<void, PersistenceError | LifecycleInvariantError> =>
  Effect.gen(function* () {
    const sequence = yield* nextSequence(sequenceRef);
    const timestamp = yield* toIsoTimestamp;
    const event = eventBuilder(sequence, timestamp);
    const lifecycleState = yield* Ref.get(lifecycleStateRef);
    const nextState = yield* applyLifecycleTransition(lifecycleState, event);

    yield* Ref.set(lifecycleStateRef, nextState);
    yield* runStore.appendEvent(runId, event);
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

const waitForRunTerminal = (
  runStore: RunStore,
  runId: RunId,
): Effect.Effect<RunSyncOutput["run"], RunNotFoundError | PersistenceError | LifecycleInvariantError> =>
  Effect.gen(function* () {
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
  lifecycleStateRef: Ref.Ref<LifecycleGuardState>,
  sequenceRef: Ref.Ref<number>,
  runStore: RunStore,
  runId: RunId,
  spawnId: string,
  message: string,
): Effect.Effect<void, PersistenceError | LifecycleInvariantError> =>
  appendTier1Event(lifecycleStateRef, sequenceRef, runStore, runId, (sequence, timestamp) => ({
    ...makeEventEnvelope(runId, sequence, timestamp),
    type: "spawn:error",
    payload: {
      spawnId: decodeSpawnIdSync(spawnId),
      message,
    },
  }));

export const makeMillEngine = (input: MakeMillEngineInput): MillEngine => {
  const runStore = makeRunStore({
    runsDirectory: input.runsDirectory,
  });

  return {
    runSync: (runInput) =>
      Effect.gen(function* () {
        const lifecycleStateRef = yield* Ref.make(initialLifecycleGuardState);
        const sequenceRef = yield* Ref.make(0);
        const spawnCounterRef = yield* Ref.make(0);
        const spawnResultsRef = yield* Ref.make<ReadonlyArray<SpawnResult>>([]);

        const startedAt = yield* toIsoTimestamp;

        yield* runStore.create({
          runId: runInput.runId,
          programPath: runInput.programPath,
          driver: input.driverName,
          timestamp: startedAt,
        });

        yield* appendTier1Event(
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

        yield* appendTier1Event(
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

            yield* appendTier1Event(
              lifecycleStateRef,
              sequenceRef,
              runStore,
              runInput.runId,
              (sequence, timestamp) => ({
                ...makeEventEnvelope(runInput.runId, sequence, timestamp),
                ...spawnStartEvent,
              }),
            );

            const driverOutputExit = yield* Effect.exit(
              Effect.mapError(
                input.driver.spawn({
                  runId: runInput.runId,
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

              yield* appendSpawnErrorEvent(
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

                yield* appendTier1Event(
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

                yield* appendTier1Event(
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
              Effect.mapError(decodeSpawnResult(driverOutputExit.value.result), (error) =>
                new ProgramExecutionError({
                  runId: runInput.runId,
                  message: `Spawn result decode failed: ${toMessage(error)}`,
                }),
              ),
            );

            if (Exit.isFailure(spawnResultExit)) {
              const failureMessage = Cause.pretty(spawnResultExit.cause);

              yield* appendSpawnErrorEvent(
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

            yield* appendTier1Event(
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

            return spawnResult;
          });

        const executionExit = yield* Effect.exit(runInput.executeProgram(spawn));
        const completedAt = yield* toIsoTimestamp;
        const spawnResults = yield* Ref.get(spawnResultsRef);

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

          yield* appendTier1Event(
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

        yield* appendTier1Event(
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
  };
};
