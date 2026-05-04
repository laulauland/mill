import * as Schema from "effect/Schema";

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
    kind: Schema.Literal("program", "agent"),
    input: Schema.optional(Schema.String),
  }),
});
export type TaskCreatedEvent = Schema.Schema.Type<typeof TaskCreatedEvent>;

export const TaskStartedEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:started"),
  payload: Schema.Struct({}),
});
export type TaskStartedEvent = Schema.Schema.Type<typeof TaskStartedEvent>;

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
    kind: Schema.Literal("program", "agent"),
  }),
});
export type TaskChildSpawnedEvent = Schema.Schema.Type<typeof TaskChildSpawnedEvent>;

export const TaskMessageChunkEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:message_chunk"),
  payload: Schema.Struct({
    text: Schema.String,
  }),
});
export type TaskMessageChunkEvent = Schema.Schema.Type<typeof TaskMessageChunkEvent>;

export const TaskThoughtChunkEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:thought_chunk"),
  payload: Schema.Struct({
    text: Schema.String,
  }),
});
export type TaskThoughtChunkEvent = Schema.Schema.Type<typeof TaskThoughtChunkEvent>;

export const TaskToolCalledEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:tool_called"),
  payload: Schema.Struct({
    toolName: Schema.String,
    arguments: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  }),
});
export type TaskToolCalledEvent = Schema.Schema.Type<typeof TaskToolCalledEvent>;

export const TaskToolReturnedEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:tool_returned"),
  payload: Schema.Struct({
    toolName: Schema.String,
    result: Schema.optional(Schema.String),
  }),
});
export type TaskToolReturnedEvent = Schema.Schema.Type<typeof TaskToolReturnedEvent>;

export const TaskCompletedEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:completed"),
  payload: Schema.Struct({
    result: Schema.optional(Schema.String),
  }),
});
export type TaskCompletedEvent = Schema.Schema.Type<typeof TaskCompletedEvent>;

export const TaskFailedEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:failed"),
  payload: Schema.Struct({
    error: Schema.String,
  }),
});
export type TaskFailedEvent = Schema.Schema.Type<typeof TaskFailedEvent>;

export const TaskCancelledEvent = Schema.Struct({
  ...EventMeta.fields,
  type: Schema.Literal("task:cancelled"),
  payload: Schema.Struct({
    reason: Schema.optional(Schema.String),
  }),
});
export type TaskCancelledEvent = Schema.Schema.Type<typeof TaskCancelledEvent>;

export const TaskEvent = Schema.Union(
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
);
export type TaskEvent = Schema.Schema.Type<typeof TaskEvent>;
