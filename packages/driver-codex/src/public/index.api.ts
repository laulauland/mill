import { Effect } from "effect";
import type { DriverCodec, DriverProcessConfig, DriverRegistration } from "@mill/core";
import { makeCodexProcessDriver } from "../process-driver.effect";

export interface CreateCodexDriverRegistrationInput {
  readonly process?: DriverProcessConfig;
  readonly models?: ReadonlyArray<string>;
}

export const createCodexCodec = (input?: {
  readonly models?: ReadonlyArray<string>;
}): DriverCodec => ({
  modelCatalog: Effect.succeed(input?.models ?? []),
});

export const createCodexDriverConfig = (): DriverProcessConfig => ({
  command: "codex",
  args: ["exec", "--json", "--skip-git-repo-check"],
  env: undefined,
});

export const createCodexDriverRegistration = (
  input?: CreateCodexDriverRegistrationInput,
): DriverRegistration => {
  const process = input?.process ?? createCodexDriverConfig();

  return {
    description: "Codex process driver",
    modelFormat: "provider/model-id",
    process,
    codec: createCodexCodec({
      models: input?.models,
    }),
    runtime: makeCodexProcessDriver(process),
  };
};
