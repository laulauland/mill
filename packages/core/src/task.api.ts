import type { AgentProvider, SpawnInput, SpawnOutput, TaskInput, TaskResult } from "./types";

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

const DefaultTaskSystemPrompt = "You are a helpful coding agent.";

export const taskInputToSpawnInput = (input: TaskInput): SpawnInput => ({
  agent: input.role ?? input.agent.driver,
  systemPrompt: input.system ?? DefaultTaskSystemPrompt,
  prompt: input.prompt,
  model: input.agent.model,
});

export const spawnOutputToTaskResult = (output: SpawnOutput): TaskResult => ({
  text: output.text,
  sessionRef: output.sessionRef,
  role: output.agent,
  model: output.model,
  driver: output.driver,
  exitCode: output.exitCode,
  stopReason: output.stopReason,
  errorMessage: output.errorMessage,
});
