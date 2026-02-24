import { Effect } from "effect";
import type { DriverCodec, DriverProcessConfig, DriverRegistration } from "@mill/core";
import { makeClaudeProcessDriver } from "../process-driver.effect";

export interface CreateClaudeDriverRegistrationInput {
  readonly process?: DriverProcessConfig;
  readonly models?: ReadonlyArray<string>;
}

export const createClaudeCodec = (input?: {
  readonly models?: ReadonlyArray<string>;
}): DriverCodec => ({
  modelCatalog: Effect.succeed(input?.models ?? []),
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
