import * as Schema from "effect/Schema";
import { TaskKind } from "./task-command";
import { TaskOutput, type TaskOutput as TaskOutputType } from "./task-state";

const EventMeta = Schema.Struct({
  taskId: Schema.String,
  sequence: Schema.Number,
  timestamp: Schema.String,
});

export const TaskCreatedEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:created"),
  payload: Schema.Struct({
    parentId: Schema.optional(Schema.String),
    kind: TaskKind,
    input: Schema.optional(Schema.String),
  }),
});
export type TaskCreatedEvent = {
  taskId: string;
  sequence: number;
  timestamp: string;
  type: "task:created";
  payload: {
    parentId?: string;
    kind: "program" | "agent" | "shell";
    input?: string;
  };
};

export const TaskStartedEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:started"),
  payload: Schema.Struct({}),
});
export type TaskStartedEvent = {
  taskId: string;
  sequence: number;
  timestamp: string;
  type: "task:started";
  payload: {};
};

export const TaskTurnStartedEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:turn_started"),
  payload: Schema.Struct({
    prompt: Schema.String,
    sequence: Schema.Number,
  }),
});
export type TaskTurnStartedEvent = {
  taskId: string;
  sequence: number;
  timestamp: string;
  type: "task:turn_started";
  payload: { prompt: string; sequence: number };
};

export const TaskTurnCompletedEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:turn_completed"),
  payload: Schema.Struct({
    text: Schema.String,
    sequence: Schema.Number,
  }),
});
export type TaskTurnCompletedEvent = {
  taskId: string;
  sequence: number;
  timestamp: string;
  type: "task:turn_completed";
  payload: { text: string; sequence: number };
};

export const TaskChildSpawnedEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:child_spawned"),
  payload: Schema.Struct({
    childId: Schema.String,
    kind: TaskKind,
    label: Schema.optional(Schema.String),
    provider: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    command: Schema.optional(Schema.String),
  }),
});
export type TaskChildSpawnedEvent = {
  taskId: string;
  sequence: number;
  timestamp: string;
  type: "task:child_spawned";
  payload: {
    childId: string;
    kind: "program" | "agent" | "shell";
    label?: string;
    provider?: string;
    model?: string;
    command?: string;
  };
};

export const TaskMessageChunkEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:message_chunk"),
  payload: Schema.Struct({
    text: Schema.String,
  }),
});
export type TaskMessageChunkEvent = {
  taskId: string;
  sequence: number;
  timestamp: string;
  type: "task:message_chunk";
  payload: { text: string };
};

export const TaskThoughtChunkEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:thought_chunk"),
  payload: Schema.Struct({
    text: Schema.String,
  }),
});
export type TaskThoughtChunkEvent = {
  taskId: string;
  sequence: number;
  timestamp: string;
  type: "task:thought_chunk";
  payload: { text: string };
};

export const TaskToolCalledEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:tool_called"),
  payload: Schema.Struct({
    toolCallId: Schema.optional(Schema.String),
    toolName: Schema.String,
    arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
});
export type TaskToolCalledEvent = {
  taskId: string;
  sequence: number;
  timestamp: string;
  type: "task:tool_called";
  payload: {
    toolCallId?: string;
    toolName: string;
    arguments?: Record<string, unknown>;
  };
};

export const TaskToolReturnedEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:tool_returned"),
  payload: Schema.Struct({
    toolCallId: Schema.optional(Schema.String),
    toolName: Schema.String,
    result: Schema.optional(Schema.String),
  }),
});
export type TaskToolReturnedEvent = {
  taskId: string;
  sequence: number;
  timestamp: string;
  type: "task:tool_returned";
  payload: {
    toolCallId?: string;
    toolName: string;
    result?: string;
  };
};

export const TaskCompletedEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:completed"),
  payload: Schema.Struct({
    result: Schema.optional(Schema.String),
    output: Schema.optional(TaskOutput),
  }),
});
export type TaskCompletedEvent = {
  taskId: string;
  sequence: number;
  timestamp: string;
  type: "task:completed";
  payload: { result?: string; output?: TaskOutputType };
};

export const TaskFailedEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:failed"),
  payload: Schema.Struct({
    error: Schema.String,
  }),
});
export type TaskFailedEvent = {
  taskId: string;
  sequence: number;
  timestamp: string;
  type: "task:failed";
  payload: { error: string };
};

export const TaskCancelledEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:cancelled"),
  payload: Schema.Struct({
    reason: Schema.optional(Schema.String),
  }),
});
export type TaskCancelledEvent = {
  taskId: string;
  sequence: number;
  timestamp: string;
  type: "task:cancelled";
  payload: { reason?: string };
};

export const TaskEvent = Schema.Union([
  TaskCreatedEvent,
  TaskStartedEvent,
  TaskTurnStartedEvent,
  TaskTurnCompletedEvent,
  TaskChildSpawnedEvent,
  TaskMessageChunkEvent,
  TaskThoughtChunkEvent,
  TaskToolCalledEvent,
  TaskToolReturnedEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
  TaskCancelledEvent,
]);

export type TaskEvent =
  | TaskCreatedEvent
  | TaskStartedEvent
  | TaskTurnStartedEvent
  | TaskTurnCompletedEvent
  | TaskChildSpawnedEvent
  | TaskMessageChunkEvent
  | TaskThoughtChunkEvent
  | TaskToolCalledEvent
  | TaskToolReturnedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskCancelledEvent;
