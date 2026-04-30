import * as Schema from "effect/Schema";
import {
  RunId,
  RunResult,
  RunStatus,
  SchemaVersion,
  TaskId,
  type RunId as RunIdType,
} from "./run.schema";
import { TaskOptions, TaskResult } from "./task.schema";

const EventEnvelope = {
  schemaVersion: SchemaVersion,
  runId: RunId,
  sequence: Schema.Int,
  timestamp: Schema.String,
} as const;

export const RunStartEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("run:start"),
  payload: Schema.Struct({
    programPath: Schema.NonEmptyString,
  }),
});
export type RunStartEvent = Schema.Schema.Type<typeof RunStartEvent>;

export const RunStatusEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("run:status"),
  payload: Schema.Struct({
    status: RunStatus,
  }),
});
export type RunStatusEvent = Schema.Schema.Type<typeof RunStatusEvent>;

export const RunCompleteEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("run:complete"),
  payload: Schema.Struct({
    result: RunResult,
  }),
});
export type RunCompleteEvent = Schema.Schema.Type<typeof RunCompleteEvent>;

export const RunFailedEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("run:failed"),
  payload: Schema.Struct({
    message: Schema.String,
  }),
});
export type RunFailedEvent = Schema.Schema.Type<typeof RunFailedEvent>;

export const RunCancelledEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("run:cancelled"),
  payload: Schema.Struct({
    reason: Schema.optional(Schema.String),
  }),
});
export type RunCancelledEvent = Schema.Schema.Type<typeof RunCancelledEvent>;

export const TaskStartEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("task:start"),
  payload: Schema.Struct({
    taskId: TaskId,
    input: TaskOptions,
  }),
});
export type TaskStartEvent = Schema.Schema.Type<typeof TaskStartEvent>;

export const TaskMilestoneEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("task:milestone"),
  payload: Schema.Struct({
    taskId: TaskId,
    message: Schema.NonEmptyString,
  }),
});
export type TaskMilestoneEvent = Schema.Schema.Type<typeof TaskMilestoneEvent>;

export const TaskToolCallEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("task:tool_call"),
  payload: Schema.Struct({
    taskId: TaskId,
    toolName: Schema.NonEmptyString,
  }),
});
export type TaskToolCallEvent = Schema.Schema.Type<typeof TaskToolCallEvent>;

export const TaskErrorEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("task:error"),
  payload: Schema.Struct({
    taskId: TaskId,
    message: Schema.String,
  }),
});
export type TaskErrorEvent = Schema.Schema.Type<typeof TaskErrorEvent>;

export const TaskMessageChunkEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("task:message_chunk"),
  payload: Schema.Struct({
    taskId: TaskId,
    text: Schema.String,
  }),
});
export type TaskMessageChunkEvent = Schema.Schema.Type<typeof TaskMessageChunkEvent>;

export const TaskThoughtChunkEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("task:thought_chunk"),
  payload: Schema.Struct({
    taskId: TaskId,
    text: Schema.String,
  }),
});
export type TaskThoughtChunkEvent = Schema.Schema.Type<typeof TaskThoughtChunkEvent>;

export const TaskPlanEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("task:plan"),
  payload: Schema.Struct({
    taskId: TaskId,
    steps: Schema.Array(Schema.String),
  }),
});
export type TaskPlanEvent = Schema.Schema.Type<typeof TaskPlanEvent>;

export const TaskCompleteEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("task:complete"),
  payload: Schema.Struct({
    taskId: TaskId,
    result: TaskResult,
  }),
});
export type TaskCompleteEvent = Schema.Schema.Type<typeof TaskCompleteEvent>;

export const TaskCancelledEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("task:cancelled"),
  payload: Schema.Struct({
    taskId: TaskId,
    reason: Schema.optional(Schema.String),
  }),
});
export type TaskCancelledEvent = Schema.Schema.Type<typeof TaskCancelledEvent>;

export const ExtensionErrorEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("extension:error"),
  payload: Schema.Struct({
    extensionName: Schema.NonEmptyString,
    hook: Schema.Literals(["setup", "onEvent"]),
    message: Schema.String,
  }),
});
export type ExtensionErrorEvent = Schema.Schema.Type<typeof ExtensionErrorEvent>;

export const MillEvent = Schema.Union([
  RunStartEvent,
  RunStatusEvent,
  RunCompleteEvent,
  RunFailedEvent,
  RunCancelledEvent,
  TaskStartEvent,
  TaskMilestoneEvent,
  TaskToolCallEvent,
  TaskMessageChunkEvent,
  TaskThoughtChunkEvent,
  TaskPlanEvent,
  TaskErrorEvent,
  TaskCompleteEvent,
  TaskCancelledEvent,
  ExtensionErrorEvent,
]);
export type MillEvent = Schema.Schema.Type<typeof MillEvent>;

export const MillEventJson = Schema.fromJsonString(MillEvent);

export const decodeMillEventJson = Schema.decodeUnknownEffect(MillEventJson);
export const decodeMillEventJsonSync = Schema.decodeUnknownSync(MillEventJson);

export const encodeMillEventJson = (event: MillEvent): string => JSON.stringify(event);

export const makeEventEnvelope = (
  runId: RunIdType,
  sequence: number,
  timestamp: string,
): Pick<MillEvent, "schemaVersion" | "runId" | "sequence" | "timestamp"> => ({
  schemaVersion: 1,
  runId,
  sequence,
  timestamp,
});
