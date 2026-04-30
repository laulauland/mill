import { describe, expect, it } from "bun:test";
import { runWithRuntime } from "./test-runtime";
import {
  createClaudeAcpAgentProvider,
  createCodexAcpAgentProvider,
  createPiAcpAgentProvider,
} from "./index";

describe("createClaudeAcpAgentProvider", () => {
  it("provides default models", async () => {
    const reg = createClaudeAcpAgentProvider();
    const models = await runWithRuntime(reg.models);

    expect(models).toContain("anthropic/claude-sonnet-4-6");
    expect(models).toContain("anthropic/claude-opus-4-6");
    expect(models).toContain("anthropic/claude-haiku-4-5");
    expect(reg.runtime).toBeDefined();
    expect(reg.description).toBe("Claude ACP provider");
  });

  it("allows custom model override", async () => {
    const reg = createClaudeAcpAgentProvider({
      models: ["custom/model-a", "custom/model-b"],
    });
    const models = await runWithRuntime(reg.models);

    expect(models).toEqual(["custom/model-a", "custom/model-b"]);
  });
});

describe("createCodexAcpAgentProvider", () => {
  it("provides default models", async () => {
    const reg = createCodexAcpAgentProvider();
    const models = await runWithRuntime(reg.models);

    expect(models).toContain("openai-codex/gpt-5.3-codex");
    expect(reg.runtime).toBeDefined();
    expect(reg.description).toBe("Codex ACP provider");
  });

  it("allows custom model override", async () => {
    const reg = createCodexAcpAgentProvider({
      models: ["custom/codex-model"],
    });
    const models = await runWithRuntime(reg.models);

    expect(models).toEqual(["custom/codex-model"]);
  });
});

describe("createPiAcpAgentProvider", () => {
  it("returns empty models when no home directory is provided", async () => {
    const reg = createPiAcpAgentProvider();
    const models = await runWithRuntime(reg.models);

    expect(models).toEqual([]);
    expect(reg.runtime).toBeDefined();
    expect(reg.description).toBe("Pi ACP provider");
  });

  it("allows custom model override", async () => {
    const reg = createPiAcpAgentProvider({
      models: ["pi/custom-model"],
    });
    const models = await runWithRuntime(reg.models);

    expect(models).toEqual(["pi/custom-model"]);
  });
});
