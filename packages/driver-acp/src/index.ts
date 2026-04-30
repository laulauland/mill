import { Effect } from "effect";
import type { AgentRuntime, AgentProcessConfig } from "@mill/core";
import { makeAcpAgentRuntime } from "./acp-driver.effect";
import { readPiSettingsFile } from "./pi-settings.adapter";
import { parsePiSettingsModels } from "./pi-settings.codec";

export interface AcpProviderConfig {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly models: Effect.Effect<ReadonlyArray<string>, never>;
  readonly description: string;
  readonly modelFormat: string;
}

export interface CreateAcpProviderInput {
  readonly process?: AgentProcessConfig;
  readonly models?: ReadonlyArray<string>;
  readonly homeDirectory?: string;
}

export interface AcpAgentProvider {
  readonly description: string;
  readonly modelFormat: string;
  readonly process: AgentProcessConfig;
  readonly models: Effect.Effect<ReadonlyArray<string>, never>;
  readonly runtime: AgentRuntime;
}

const normalizeModelCatalog = (models: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.from(new Set(models.map((model) => model.trim()).filter((model) => model.length > 0)));

const createAcpAgentProvider = (
  config: AcpProviderConfig,
  name: string,
  runtimeProcess?: AgentProcessConfig,
): AcpAgentProvider => {
  const processConfig: AgentProcessConfig = {
    command: config.command,
    args: config.args,
    env: config.env,
  };

  return {
    description: config.description,
    modelFormat: config.modelFormat,
    process: processConfig,
    models: Effect.map(config.models, normalizeModelCatalog),
    runtime: makeAcpAgentRuntime(name, runtimeProcess),
  };
};

// --- Claude ACP ---

const DEFAULT_CLAUDE_MODELS = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-haiku-4-5",
] as const;

export const createClaudeAcpAgentProvider = (input?: CreateAcpProviderInput): AcpAgentProvider =>
  createAcpAgentProvider(
    {
      command: input?.process?.command ?? "claude",
      args: input?.process?.args ?? [],
      env: input?.process?.env,
      models: Effect.succeed(input?.models ?? DEFAULT_CLAUDE_MODELS),
      description: "Claude ACP provider",
      modelFormat: "provider/model-id",
    },
    "claude",
    input?.process,
  );

// --- Codex ACP ---

const DEFAULT_CODEX_MODELS = ["openai-codex/gpt-5.3-codex"] as const;

export const createCodexAcpAgentProvider = (input?: CreateAcpProviderInput): AcpAgentProvider =>
  createAcpAgentProvider(
    {
      command: input?.process?.command ?? "codex-acp",
      args: input?.process?.args ?? [],
      env: input?.process?.env,
      models: Effect.succeed(input?.models ?? DEFAULT_CODEX_MODELS),
      description: "Codex ACP provider",
      modelFormat: "provider/model-id",
    },
    "codex",
    input?.process,
  );

// --- Pi ACP ---

const readPiEnabledModels = (
  homeDirectory?: string,
): Effect.Effect<ReadonlyArray<string>, never> => {
  if (homeDirectory === undefined || homeDirectory.length === 0) {
    return Effect.succeed([]);
  }

  return Effect.map(readPiSettingsFile(homeDirectory), (raw) =>
    raw === undefined ? [] : parsePiSettingsModels(raw),
  );
};

export const createPiAcpAgentProvider = (input?: CreateAcpProviderInput): AcpAgentProvider =>
  createAcpAgentProvider(
    {
      command: input?.process?.command ?? "pi",
      args: input?.process?.args ?? ["acp"],
      env: input?.process?.env,
      models:
        input?.models === undefined
          ? readPiEnabledModels(input?.homeDirectory)
          : Effect.succeed(input.models),
      description: "Pi ACP provider",
      modelFormat: "provider/model-id",
    },
    "pi",
    input?.process,
  );
