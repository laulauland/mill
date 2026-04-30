import * as Schema from "effect/Schema";

export const TaskOptions = Schema.Struct({
  role: Schema.NonEmptyString,
  system: Schema.NonEmptyString,
  prompt: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  driver: Schema.NonEmptyString,
});

export type TaskOptions = Schema.Schema.Type<typeof TaskOptions>;

export const TaskResult = Schema.Struct({
  text: Schema.String,
  sessionRef: Schema.NonEmptyString,
  role: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  driver: Schema.NonEmptyString,
  exitCode: Schema.Number,
  stopReason: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
});

export type TaskResult = Schema.Schema.Type<typeof TaskResult>;

export const decodeTaskOptions = Schema.decodeUnknownEffect(TaskOptions);
export const decodeTaskOptionsSync = Schema.decodeUnknownSync(TaskOptions);
export const decodeTaskResult = Schema.decodeUnknownEffect(TaskResult);
export const decodeTaskResultSync = Schema.decodeUnknownSync(TaskResult);
