import type { AgentProvider } from "./types";

export const codex = (model: string): AgentProvider => ({
  driver: "codex",
  model,
});

export const claude = (model: string): AgentProvider => ({
  driver: "claude",
  model,
});

export const pi = (model: string): AgentProvider => ({
  driver: "pi",
  model,
});
