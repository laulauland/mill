import { Effect } from "effect";
import type { DriverCodec, DriverProcessConfig, DriverRegistration } from "@mill/core";

const CLAUDE_MODELS: ReadonlyArray<string> = ["anthropic/claude-sonnet-4-6"];

export interface CreateClaudeDriverRegistrationInput {
  readonly process?: DriverProcessConfig;
}

export const createClaudeCodec = (): DriverCodec => ({
  modelCatalog: Effect.succeed(CLAUDE_MODELS),
});

export const createClaudeDriverConfig = (): DriverProcessConfig => ({
  command: "claude",
  args: [],
  env: {},
});

export const createClaudeDriverRegistration = (
  input?: CreateClaudeDriverRegistrationInput,
): DriverRegistration => {
  const process = input?.process ?? createClaudeDriverConfig();

  return {
    description: "Claude process driver",
    modelFormat: "provider/model-id",
    process,
    codec: createClaudeCodec(),
    runtime: {
      name: "claude",
      spawn: (spawnInput) =>
        Effect.succeed({
          events: [
            {
              type: "milestone",
              message: `claude:${spawnInput.agent}`,
            },
          ],
          result: {
            text: `claude:${spawnInput.prompt}`,
            sessionRef: `session/claude/${spawnInput.agent}`,
            agent: spawnInput.agent,
            model: spawnInput.model,
            driver: "claude",
            exitCode: 0,
            stopReason: "complete",
          },
        }),
    },
  };
};
