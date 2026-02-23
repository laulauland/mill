import { Data, Effect } from "effect";
import type { MillEvent } from "../domain/event.schema";
import type { RunStatus } from "../domain/run.schema";

type RunTerminalEventType = Extract<
  MillEvent["type"],
  "run:complete" | "run:failed" | "run:cancelled"
>;
type SpawnTerminalEventType = Extract<
  MillEvent["type"],
  "spawn:complete" | "spawn:error" | "spawn:cancelled"
>;

export class LifecycleInvariantError extends Data.TaggedError("LifecycleInvariantError")<{
  runId: string;
  message: string;
}> {}

export type LifecycleGuardState = {
  readonly runTerminal?: RunTerminalEventType;
  readonly spawnTerminals: Readonly<Record<string, SpawnTerminalEventType>>;
};

export const initialLifecycleGuardState: LifecycleGuardState = {
  spawnTerminals: {},
};

const isRunTerminalType = (eventType: MillEvent["type"]): eventType is RunTerminalEventType =>
  eventType === "run:complete" || eventType === "run:failed" || eventType === "run:cancelled";

const isSpawnTerminalType = (eventType: MillEvent["type"]): eventType is SpawnTerminalEventType =>
  eventType === "spawn:complete" || eventType === "spawn:error" || eventType === "spawn:cancelled";

const spawnIdForEvent = (event: MillEvent): string | undefined => {
  if (event.type === "spawn:start") {
    return event.payload.spawnId;
  }

  if (event.type === "spawn:milestone") {
    return event.payload.spawnId;
  }

  if (event.type === "spawn:tool_call") {
    return event.payload.spawnId;
  }

  if (event.type === "spawn:complete") {
    return event.payload.spawnId;
  }

  if (event.type === "spawn:error") {
    return event.payload.spawnId;
  }

  if (event.type === "spawn:cancelled") {
    return event.payload.spawnId;
  }

  return undefined;
};

export const applyLifecycleTransition = (
  state: LifecycleGuardState,
  event: MillEvent,
): Effect.Effect<LifecycleGuardState, LifecycleInvariantError> =>
  Effect.gen(function* () {
    if (state.runTerminal !== undefined) {
      return yield* Effect.fail(
        new LifecycleInvariantError({
          runId: event.runId,
          message: `Event ${event.type} violates terminal single-shot policy: run already terminal with ${state.runTerminal}.`,
        }),
      );
    }

    const spawnId = spawnIdForEvent(event);

    if (spawnId !== undefined && state.spawnTerminals[spawnId] !== undefined) {
      return yield* Effect.fail(
        new LifecycleInvariantError({
          runId: event.runId,
          message: `Event ${event.type} violates terminal single-shot policy for spawn ${spawnId}: terminal already set to ${state.spawnTerminals[spawnId]}.`,
        }),
      );
    }

    const nextRunTerminal = isRunTerminalType(event.type) ? event.type : state.runTerminal;

    if (spawnId === undefined || !isSpawnTerminalType(event.type)) {
      return {
        ...state,
        runTerminal: nextRunTerminal,
      };
    }

    return {
      ...state,
      runTerminal: nextRunTerminal,
      spawnTerminals: {
        ...state.spawnTerminals,
        [spawnId]: event.type,
      },
    };
  });

const isTerminalStatus = (status: RunStatus): boolean =>
  status === "complete" || status === "failed" || status === "cancelled";

export const ensureRunStatusTransition = (
  runId: string,
  current: RunStatus,
  next: RunStatus,
): Effect.Effect<void, LifecycleInvariantError> => {
  if (isTerminalStatus(current)) {
    return Effect.fail(
      new LifecycleInvariantError({
        runId,
        message: `Run status transition ${current} -> ${next} is invalid: terminal statuses are immutable.`,
      }),
    );
  }

  if (current === "pending" && next === "running") {
    return Effect.void;
  }

  if (current === "pending" && next === "pending") {
    return Effect.void;
  }

  if (current === "running" && (next === "running" || isTerminalStatus(next))) {
    return Effect.void;
  }

  return Effect.fail(
    new LifecycleInvariantError({
      runId,
      message: `Run status transition ${current} -> ${next} violates lifecycle transition guards.`,
    }),
  );
};

export const isRunTerminalEvent = (event: MillEvent): boolean => isRunTerminalType(event.type);
