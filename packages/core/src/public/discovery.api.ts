import type { DiscoveryPayload } from "./types";

export const createDiscoveryPayload = async (): Promise<DiscoveryPayload> => ({
  discoveryVersion: 1,
  programApi: {
    spawnRequired: ["agent", "systemPrompt", "prompt"],
    spawnOptional: ["model"],
    resultFields: ["text", "sessionRef", "agent", "model", "driver", "exitCode", "stopReason"],
  },
  drivers: {
    default: {
      description: "Local process driver",
      modelFormat: "provider/model-id",
      models: ["openai/gpt-5.3-codex", "anthropic/claude-sonnet-4-6"],
    },
  },
  authoring: {
    instructions:
      "Use systemPrompt for WHO and prompt for WHAT. Prefer cheaper models for search and stronger models for synthesis.",
  },
  async: {
    submit: "mill run <program.ts> --json",
    status: "mill status <runId> --json",
    wait: "mill wait <runId> --timeout 30 --json",
  },
});
