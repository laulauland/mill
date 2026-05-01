import type { AgentProvider } from "./types";

export const codex = (model: string): AgentProvider => ({
  provider: "codex",
  model,
});

export const claude = (model: string): AgentProvider => ({
  provider: "claude",
  model,
});

export const pi = (model: string): AgentProvider => ({
  provider: "pi",
  model,
});
