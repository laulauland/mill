import { describe, expect, test } from "bun:test";
import { task, codex, claude, pi, ProgramContextError } from "./program.api";

describe("program.api", () => {
  test("task() outside program context throws", () => {
    expect(() => task({ agent: codex("gpt-5") })).toThrow(ProgramContextError);
  });

  test("codex returns correct provider", () => {
    const agent = codex("gpt-5");
    expect(agent.provider).toBe("codex");
    expect(agent.model).toBe("gpt-5");
  });

  test("claude returns correct provider", () => {
    const agent = claude("claude-4");
    expect(agent.provider).toBe("claude");
    expect(agent.model).toBe("claude-4");
  });

  test("pi returns correct provider", () => {
    const agent = pi("pi-1");
    expect(agent.provider).toBe("pi");
    expect(agent.model).toBe("pi-1");
  });
});
