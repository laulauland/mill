import * as Schema from "effect/Schema";

export const TaskKind = Schema.Union([Schema.Literal("program"), Schema.Literal("agent")]);
export type TaskKind = "program" | "agent";

export const TaskStatus = Schema.Union([
  Schema.Literal("created"),
  Schema.Literal("started"),
  Schema.Literal("completed"),
  Schema.Literal("failed"),
  Schema.Literal("cancelled"),
]);
export type TaskStatus = "created" | "started" | "completed" | "failed" | "cancelled";

export const CreateTask = Schema.Struct({
  _tag: Schema.Literal("CreateTask"),
  kind: TaskKind,
  input: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.String),
});
export type CreateTask = {
  _tag: "CreateTask";
  kind: TaskKind;
  input?: string;
  parentId?: string;
};

export const SendMessage = Schema.Struct({
  _tag: Schema.Literal("SendMessage"),
  taskId: Schema.String,
  content: Schema.String,
  sequence: Schema.optional(Schema.Number),
});
export type SendMessage = {
  _tag: "SendMessage";
  taskId: string;
  content: string;
  sequence?: number;
};

export const CompleteTask = Schema.Struct({
  _tag: Schema.Literal("CompleteTask"),
  taskId: Schema.String,
});
export type CompleteTask = {
  _tag: "CompleteTask";
  taskId: string;
};

export const CancelTask = Schema.Struct({
  _tag: Schema.Literal("CancelTask"),
  taskId: Schema.String,
  reason: Schema.optional(Schema.String),
});
export type CancelTask = {
  _tag: "CancelTask";
  taskId: string;
  reason?: string;
};

export const TaskCommand = Schema.Union([CreateTask, SendMessage, CompleteTask, CancelTask]);
export type TaskCommand = CreateTask | SendMessage | CompleteTask | CancelTask;

export const GetTask = Schema.Struct({
  _tag: Schema.Literal("GetTask"),
  taskId: Schema.String,
});
export type GetTask = {
  _tag: "GetTask";
  taskId: string;
};

export const ListTasks = Schema.Struct({
  _tag: Schema.Literal("ListTasks"),
});
export type ListTasks = {
  _tag: "ListTasks";
};

export const GetChildTasks = Schema.Struct({
  _tag: Schema.Literal("GetChildTasks"),
  taskId: Schema.String,
});
export type GetChildTasks = {
  _tag: "GetChildTasks";
  taskId: string;
};

export const TaskQuery = Schema.Union([GetTask, ListTasks, GetChildTasks]);
export type TaskQuery = GetTask | ListTasks | GetChildTasks;
