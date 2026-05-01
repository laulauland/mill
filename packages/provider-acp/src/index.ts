import type { AgentRuntime, AgentProcessConfig } from "@mill/core";
import { makeAcpProviderRuntime } from "./acp-provider.effect";

export interface AcpProviderConfig {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly description: string;
}

export interface CreateAcpProviderInput {
  readonly process?: AgentProcessConfig;
}

export interface AcpAgentProvider {
  readonly description: string;
  readonly process: AgentProcessConfig;
  readonly runtime: AgentRuntime;
}

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
    process: processConfig,
    runtime: makeAcpProviderRuntime(name, runtimeProcess),
  };
};

export const createClaudeAcpAgentProvider = (input?: CreateAcpProviderInput): AcpAgentProvider =>
  createAcpAgentProvider(
    {
      command: input?.process?.command ?? "claude",
      args: input?.process?.args ?? [],
      env: input?.process?.env,
      description: "Claude ACP provider",
    },
    "claude",
    input?.process,
  );

export const createCodexAcpAgentProvider = (input?: CreateAcpProviderInput): AcpAgentProvider =>
  createAcpAgentProvider(
    {
      command: input?.process?.command ?? "codex-acp",
      args: input?.process?.args ?? [],
      env: input?.process?.env,
      description: "Codex ACP provider",
    },
    "codex",
    input?.process,
  );

export const createPiAcpAgentProvider = (input?: CreateAcpProviderInput): AcpAgentProvider =>
  createAcpAgentProvider(
    {
      command: input?.process?.command ?? "pi",
      args: input?.process?.args ?? ["acp"],
      env: input?.process?.env,
      description: "Pi ACP provider",
    },
    "pi",
    input?.process,
  );
