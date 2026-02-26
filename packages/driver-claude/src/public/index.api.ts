import { Effect } from "effect";
import type { DriverCodec, DriverProcessConfig, DriverRegistration } from "@mill/core";
import { makeClaudeProcessDriver } from "../process-driver.effect";

export interface CreateClaudeDriverRegistrationInput {
  readonly process?: DriverProcessConfig;
  readonly models?: ReadonlyArray<string>;
}

const DEFAULT_CLAUDE_MODELS = ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"] as const;

const normalizeModelCatalog = (models: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.from(new Set(models.map((model) => model.trim()).filter((model) => model.length > 0)));

export const createClaudeCodec = (input?: {
  readonly models?: ReadonlyArray<string>;
}): DriverCodec => ({
  modelCatalog: Effect.succeed(normalizeModelCatalog(input?.models ?? DEFAULT_CLAUDE_MODELS)),
});

export const createClaudeDriverConfig = (): DriverProcessConfig => ({
  command: "claude",
  args: ["--print", "--verbose", "--output-format", "stream-json"],
  env: undefined,
});

export const createClaudeDriverRegistration = (
  input?: CreateClaudeDriverRegistrationInput,
): DriverRegistration => {
  const process = input?.process ?? createClaudeDriverConfig();

  return {
    description: "Claude process driver",
    modelFormat: "provider/model-id",
    process,
    codec: createClaudeCodec({
      models: input?.models,
    }),
    runtime: makeClaudeProcessDriver(process),
  };
};
