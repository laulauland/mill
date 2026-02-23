import { Effect } from "effect";
import type { DriverCodec, DriverProcessConfig, DriverRegistration } from "@mill/core";

const CODEX_MODELS: ReadonlyArray<string> = ["openai/gpt-5.3-codex"];

export interface CreateCodexDriverRegistrationInput {
  readonly process?: DriverProcessConfig;
}

export const createCodexCodec = (): DriverCodec => ({
  modelCatalog: Effect.succeed(CODEX_MODELS),
});

export const createCodexDriverConfig = (): DriverProcessConfig => ({
  command: "codex",
  args: [],
  env: {},
});

export const createCodexDriverRegistration = (
  input?: CreateCodexDriverRegistrationInput,
): DriverRegistration => {
  const process = input?.process ?? createCodexDriverConfig();

  return {
    description: "Codex process driver",
    modelFormat: "provider/model-id",
    process,
    codec: createCodexCodec(),
    runtime: {
      name: "codex",
      spawn: (spawnInput) =>
        Effect.succeed({
          events: [
            {
              type: "milestone",
              message: `codex:${spawnInput.agent}`,
            },
          ],
          result: {
            text: `codex:${spawnInput.prompt}`,
            sessionRef: `session/codex/${spawnInput.agent}`,
            agent: spawnInput.agent,
            model: spawnInput.model,
            driver: "codex",
            exitCode: 0,
            stopReason: "complete",
          },
        }),
    },
  };
};
