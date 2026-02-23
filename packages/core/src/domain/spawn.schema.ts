import * as Schema from "@effect/schema/Schema";

export const SpawnOptions = Schema.Struct({
  agent: Schema.NonEmptyString,
  systemPrompt: Schema.NonEmptyString,
  prompt: Schema.NonEmptyString,
  model: Schema.optional(Schema.NonEmptyString),
});

export type SpawnOptions = Schema.Schema.Type<typeof SpawnOptions>;

export const SpawnResult = Schema.Struct({
  text: Schema.String,
  sessionRef: Schema.NonEmptyString,
  agent: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  driver: Schema.NonEmptyString,
  exitCode: Schema.Number,
  stopReason: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
});

export type SpawnResult = Schema.Schema.Type<typeof SpawnResult>;
