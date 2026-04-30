import { Data, Effect } from "effect";
import type { MillEvent } from "./event.schema";
import type { RunStatus } from "./run.schema";

type RunTerminalEventType = Extract<
  MillEvent["type"],
  "run:complete" | "run:failed" | "run:cancelled"
>;
type TaskTerminalEventType = Extract<
  MillEvent["type"],
  "task:complete" | "task:error" | "task:cancelled"
>;

export class LifecycleInvariantError extends Data.TaggedError("LifecycleInvariantError")<{
  runId: string;
  message: string;
}> {}

export type LifecycleGuardState = {
  readonly runTerminal?: RunTerminalEventType;
  readonly taskTerminals: Readonly<Record<string, TaskTerminalEventType>>;
};

export const initialLifecycleGuardState: LifecycleGuardState = {
  taskTerminals: {},
};

const isRunTerminalType = (eventType: MillEvent["type"]): eventType is RunTerminalEventType =>
  eventType === "run:complete" || eventType === "run:failed" || eventType === "run:cancelled";

const isTaskTerminalType = (eventType: MillEvent["type"]): eventType is TaskTerminalEventType =>
  eventType === "task:complete" || eventType === "task:error" || eventType === "task:cancelled";

const taskIdForEvent = (event: MillEvent): string | undefined => {
  if (event.type === "task:start") {
    return event.payload.taskId;
  }

  if (event.type === "task:milestone") {
    return event.payload.taskId;
  }

  if (event.type === "task:tool_call") {
    return event.payload.taskId;
  }

  if (event.type === "task:message_chunk") {
    return event.payload.taskId;
  }

  if (event.type === "task:thought_chunk") {
    return event.payload.taskId;
  }

  if (event.type === "task:plan") {
    return event.payload.taskId;
  }

  if (event.type === "task:complete") {
    return event.payload.taskId;
  }

  if (event.type === "task:error") {
    return event.payload.taskId;
  }

  if (event.type === "task:cancelled") {
    return event.payload.taskId;
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

    const taskId = taskIdForEvent(event);

    if (taskId !== undefined && state.taskTerminals[taskId] !== undefined) {
      return yield* Effect.fail(
        new LifecycleInvariantError({
          runId: event.runId,
          message: `Event ${event.type} violates terminal single-shot policy for task ${taskId}: terminal already set to ${state.taskTerminals[taskId]}.`,
        }),
      );
    }

    const nextRunTerminal = isRunTerminalType(event.type) ? event.type : state.runTerminal;

    if (taskId === undefined || !isTaskTerminalType(event.type)) {
      return {
        ...state,
        runTerminal: nextRunTerminal,
      };
    }

    return {
      ...state,
      runTerminal: nextRunTerminal,
      taskTerminals: {
        ...state.taskTerminals,
        [taskId]: event.type,
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

  if (current === "pending" && next === "cancelled") {
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
