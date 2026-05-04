import * as Schema from "effect/Schema";
import { TaskStatus } from "./task-command";

export type TaskTerminalErrorOptions = {
  readonly taskId: string;
  readonly message: string;
};

export class TaskTerminalError extends Error {
  readonly _tag: string = "TaskTerminalError";
  readonly taskId: string;

  constructor(options: TaskTerminalErrorOptions) {
    super(options.message);
    this.name = "TaskTerminalError";
    this.taskId = options.taskId;
  }
}

export class TaskFailedError extends TaskTerminalError {
  override readonly _tag = "TaskFailedError";

  constructor(options: TaskTerminalErrorOptions) {
    super(options);
    this.name = "TaskFailedError";
  }
}

export class TaskCancelledError extends TaskTerminalError {
  override readonly _tag = "TaskCancelledError";

  constructor(options: TaskTerminalErrorOptions) {
    super(options);
    this.name = "TaskCancelledError";
  }
}

export const TurnResult = Schema.Struct({
  text: Schema.String,
  sequence: Schema.Number,
});

export type TurnResult = {
  readonly text: string;
  readonly sequence: number;
};

export const TaskOutput = Schema.Struct({
  kind: Schema.Literal("agent"),
  text: Schema.String,
});

export type TaskOutput = {
  readonly kind: "agent";
  readonly text: string;
};

export const TaskResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("completed"),
    output: TaskOutput,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    error: Schema.instanceOf(TaskFailedError),
  }),
  Schema.Struct({
    status: Schema.Literal("cancelled"),
    error: Schema.instanceOf(TaskCancelledError),
  }),
]);

export type TaskResult =
  | { readonly status: "completed"; readonly output: TaskOutput }
  | { readonly status: "failed"; readonly error: TaskFailedError }
  | { readonly status: "cancelled"; readonly error: TaskCancelledError };

export const TaskSnapshot = Schema.Struct({
  id: Schema.String,
  status: TaskStatus,
  text: Schema.optional(Schema.String),
  thought: Schema.optional(Schema.String),
  history: Schema.optional(
    Schema.Array(
      Schema.Struct({
        prompt: Schema.String,
        text: Schema.String,
      }),
    ),
  ),
  pending: Schema.optional(
    Schema.Struct({
      type: Schema.Literal("message"),
      content: Schema.String,
    }),
  ),
  busy: Schema.optional(Schema.Boolean),
  output: Schema.optional(TaskOutput),
});

export type TaskSnapshot = {
  id: string;
  status: TaskStatus;
  text: string;
  thought: string;
  history: ReadonlyArray<{ prompt: string; text: string }>;
  pending?: { type: "message"; content: string };
  busy: boolean;
  output?: TaskOutput;
};

export const TaskState = Schema.Struct({
  snapshot: TaskSnapshot,
  children: Schema.optional(Schema.Array(Schema.String)),
});

export type TaskState = {
  snapshot: TaskSnapshot;
  children: ReadonlyArray<string>;
};
