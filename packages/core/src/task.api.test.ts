import { describe, expect, it } from "bun:test";
import { claude, codex, pi, spawnOutputToTaskResult, taskInputToSpawnInput } from "./task.api";

const agentModel = "openai-codex/gpt-5.3-codex";

describe("agent provider factories", () => {
  it("creates provider descriptors for built-in ACP drivers", () => {
    expect(codex(agentModel)).toEqual({
      driver: "codex",
      model: agentModel,
    });

    expect(claude("anthropic/claude-opus-4-6")).toEqual({
      driver: "claude",
      model: "anthropic/claude-opus-4-6",
    });

    expect(pi("pi/default")).toEqual({
      driver: "pi",
      model: "pi/default",
    });
  });
});

describe("task compatibility mapping", () => {
  it("maps public task input to the legacy spawn input shape", () => {
    expect(
      taskInputToSpawnInput({
        agent: codex(agentModel),
        system: "You inspect code.",
        prompt: "Review src/auth.",
        role: "scout",
        steering: "queue",
      }),
    ).toEqual({
      agent: "scout",
      systemPrompt: "You inspect code.",
      prompt: "Review src/auth.",
      model: agentModel,
    });
  });

  it("falls back to the provider driver as the legacy agent label", () => {
    expect(
      taskInputToSpawnInput({
        agent: claude("anthropic/claude-sonnet-4-5"),
        prompt: "Plan the change.",
      }).agent,
    ).toBe("claude");
  });

  it("maps legacy spawn output to task result vocabulary", () => {
    expect(
      spawnOutputToTaskResult({
        text: "done",
        sessionRef: "session/1",
        agent: "planner",
        model: "anthropic/claude-sonnet-4-5",
        driver: "claude",
        exitCode: 0,
      }),
    ).toEqual({
      text: "done",
      sessionRef: "session/1",
      role: "planner",
      model: "anthropic/claude-sonnet-4-5",
      driver: "claude",
      exitCode: 0,
    });
  });
});
