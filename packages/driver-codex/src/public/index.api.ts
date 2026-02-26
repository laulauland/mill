import { Effect } from "effect";
import type { DriverCodec, DriverProcessConfig, DriverRegistration } from "@mill/core";
import { makeCodexProcessDriver } from "../process-driver.effect";

export interface CreateCodexDriverRegistrationInput {
  readonly process?: DriverProcessConfig;
  readonly models?: ReadonlyArray<string>;
}

const DEFAULT_CODEX_MODELS = ["openai-codex/gpt-5.3-codex"] as const;

const normalizeModelCatalog = (models: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.from(new Set(models.map((model) => model.trim()).filter((model) => model.length > 0)));

export const createCodexCodec = (input?: {
  readonly models?: ReadonlyArray<string>;
}): DriverCodec => ({
  modelCatalog: Effect.succeed(normalizeModelCatalog(input?.models ?? DEFAULT_CODEX_MODELS)),
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
