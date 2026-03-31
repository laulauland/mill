import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Effect } from "effect";
import type { DriverCodec, DriverProcessConfig, DriverRegistration } from "@mill/core";
import { makeAcpDriver } from "./acp-driver.effect";
import { parsePiSettingsModels } from "./pi-settings.codec";

export type AcpDriverConfig = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly models: ReadonlyArray<string>;
  readonly description: string;
  readonly modelFormat: string;
};

export type CreateAcpDriverRegistrationInput = {
  readonly process?: DriverProcessConfig;
  readonly models?: ReadonlyArray<string>;
  readonly homeDirectory?: string;
};

const normalizeModelCatalog = (models: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.from(new Set(models.map((model) => model.trim()).filter((model) => model.length > 0)));

const createAcpCodec = (models: ReadonlyArray<string>): DriverCodec => ({
  modelCatalog: Effect.succeed(normalizeModelCatalog(models)),
});

const createAcpDriverRegistration = (config: AcpDriverConfig, name: string): DriverRegistration => {
  const processConfig: DriverProcessConfig = {
    command: config.command,
    args: config.args,
    env: config.env,
  };

  return {
    description: config.description,
    modelFormat: config.modelFormat,
    process: processConfig,
    codec: createAcpCodec(config.models),
    runtime: makeAcpDriver(name, processConfig),
  };
};

// --- Claude ACP ---

const DEFAULT_CLAUDE_MODELS = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-haiku-4-5",
] as const;

export const createClaudeAcpDriverRegistration = (
  input?: CreateAcpDriverRegistrationInput,
): DriverRegistration =>
  createAcpDriverRegistration(
    {
      command: input?.process?.command ?? "claude-agent-acp",
      args: input?.process?.args ?? [],
      env: input?.process?.env ?? { CLAUDECODE: "" },
      models: input?.models ?? DEFAULT_CLAUDE_MODELS,
      description: "Claude ACP driver",
      modelFormat: "provider/model-id",
    },
    "claude",
  );

// --- Codex ACP ---

const DEFAULT_CODEX_MODELS = ["openai-codex/gpt-5.3-codex"] as const;

export const createCodexAcpDriverRegistration = (
  input?: CreateAcpDriverRegistrationInput,
): DriverRegistration =>
  createAcpDriverRegistration(
    {
      command: input?.process?.command ?? "codex-acp",
      args: input?.process?.args ?? [],
      env: input?.process?.env,
      models: input?.models ?? DEFAULT_CODEX_MODELS,
      description: "Codex ACP driver",
      modelFormat: "provider/model-id",
    },
    "codex",
  );

// --- Pi ACP ---

const readPiEnabledModels = (homeDirectory?: string): ReadonlyArray<string> => {
  if (homeDirectory === undefined || homeDirectory.length === 0) {
    return [];
  }

  const settingsPath = join(homeDirectory, ".pi", "agent", "settings.json");

  if (!existsSync(settingsPath)) {
    return [];
  }

  try {
    const raw = readFileSync(settingsPath, "utf8");
    return parsePiSettingsModels(raw);
  } catch {
    return [];
  }
};

export const createPiAcpDriverRegistration = (
  input?: CreateAcpDriverRegistrationInput,
): DriverRegistration =>
  createAcpDriverRegistration(
    {
      command: input?.process?.command ?? "pi-acp",
      args: input?.process?.args ?? [],
      env: input?.process?.env,
      models: input?.models ?? readPiEnabledModels(input?.homeDirectory),
      description: "Pi ACP driver",
      modelFormat: "provider/model-id",
    },
    "pi",
  );
