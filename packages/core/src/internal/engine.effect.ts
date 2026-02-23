import { Data, Effect } from "effect";
import type { RunId, RunRecord } from "../domain/run.schema";
import type { SpawnOptions, SpawnResult } from "../domain/spawn.schema";

export class ConfigError extends Data.TaggedError("ConfigError")<{ message: string }> {}

export class RunNotFoundError extends Data.TaggedError("RunNotFoundError")<{ runId: string }> {}

export class ProgramExecutionError extends Data.TaggedError("ProgramExecutionError")<{
  runId: string;
  message: string;
}> {}

export class PersistenceError extends Data.TaggedError("PersistenceError")<{
  path: string;
  message: string;
}> {}

export interface MillEngine {
  readonly submit: (
    input: SpawnOptions,
  ) => Effect.Effect<SpawnResult, ConfigError | PersistenceError | ProgramExecutionError>;
  readonly status: (runId: RunId) => Effect.Effect<RunRecord, RunNotFoundError | PersistenceError>;
}

const buildNoopResult = (input: SpawnOptions): SpawnResult => ({
  text: `noop response for ${input.agent}`,
  sessionRef: "session/noop",
  agent: input.agent,
  model: input.model ?? "openai/gpt-5.3-codex",
  driver: "default",
  exitCode: 0,
});

export const makeNoopMillEngine: Effect.Effect<MillEngine> = Effect.succeed({
  submit: (input) => Effect.succeed(buildNoopResult(input)),
  status: () => Effect.fail(new RunNotFoundError({ runId: "missing" })),
});
