import { describe, expect, it } from "bun:test";
import { claude, codex, pi } from "./task.api";

const agentModel = "openai-codex/gpt-5.3-codex";

describe("agent provider factories", () => {
  it("creates provider descriptors for built-in ACP providers", () => {
    expect(codex(agentModel)).toEqual({
      provider: "codex",
      model: agentModel,
    });

    expect(claude("anthropic/claude-opus-4-6")).toEqual({
      provider: "claude",
      model: "anthropic/claude-opus-4-6",
    });

    expect(pi("pi/default")).toEqual({
      provider: "pi",
      model: "pi/default",
    });
  });
});
