import { describe, expect, test } from "bun:test";
import { buildMillProgramSource, buildMillTaskPayload, inferMillDriverFromModel } from "../runtime";

describe("pi-mill runtime program generation", () => {
  test("generates core-compatible task payload with provider agent and role", () => {
    const payload = buildMillTaskPayload({
      role: "security",
      system: "You are a security reviewer.",
      prompt: "Review src/auth.",
      modelId: "openai-codex/gpt-5.3-codex",
    });

    expect(payload).toEqual({
      agent: {
        driver: "codex",
        model: "openai-codex/gpt-5.3-codex",
      },
      role: "security",
      system: "You are a security reviewer.",
      prompt: "Review src/auth.",
    });
  });

  test("generated program uses actor-shaped mill.task API", () => {
    const source = buildMillProgramSource({
      role: "security",
      system: "You are a security reviewer.",
      prompt: "Review src/auth.",
      modelId: "openai-codex/gpt-5.3-codex",
    });

    expect(source).toContain("const task = mill.task(");
    expect(source).toContain('"agent":{"driver":"codex","model":"openai-codex/gpt-5.3-codex"}');
    expect(source).toContain('"role":"security"');
    expect(source).toContain(".start();");
    expect(source).toContain("await task.done;");
    expect(source).not.toContain(`system${"Prompt"}`);
    expect(source).not.toContain('"model":"openai-codex/gpt-5.3-codex","agent":"security"');
  });

  test("infers mill driver from pi-mill model selectors", () => {
    expect(inferMillDriverFromModel("openai-codex/gpt-5.3-codex")).toBe("codex");
    expect(inferMillDriverFromModel("anthropic/claude-sonnet-4-6")).toBe("claude");
    expect(inferMillDriverFromModel("cerebras/zai-glm-4.7")).toBe("pi");
  });
});
