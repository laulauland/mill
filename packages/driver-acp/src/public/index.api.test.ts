import { describe, expect, it } from "bun:test";
import { runWithRuntime } from "./test-runtime.api";
import {
  createClaudeAcpDriverRegistration,
  createCodexAcpDriverRegistration,
  createPiAcpDriverRegistration,
} from "./index.api";

describe("createClaudeAcpDriverRegistration", () => {
  it("provides default models", async () => {
    const reg = createClaudeAcpDriverRegistration();
    const models = await runWithRuntime(reg.codec.modelCatalog);

    expect(models).toContain("anthropic/claude-sonnet-4-6");
    expect(models).toContain("anthropic/claude-opus-4-6");
    expect(models).toContain("anthropic/claude-haiku-4-5");
    expect(reg.runtime).toBeDefined();
    expect(reg.description).toBe("Claude ACP driver");
  });

  it("allows custom model override", async () => {
    const reg = createClaudeAcpDriverRegistration({
      models: ["custom/model-a", "custom/model-b"],
    });
    const models = await runWithRuntime(reg.codec.modelCatalog);

    expect(models).toEqual(["custom/model-a", "custom/model-b"]);
  });
});

describe("createCodexAcpDriverRegistration", () => {
  it("provides default models", async () => {
    const reg = createCodexAcpDriverRegistration();
    const models = await runWithRuntime(reg.codec.modelCatalog);

    expect(models).toContain("openai-codex/gpt-5.3-codex");
    expect(reg.runtime).toBeDefined();
    expect(reg.description).toBe("Codex ACP driver");
  });

  it("allows custom model override", async () => {
    const reg = createCodexAcpDriverRegistration({
      models: ["custom/codex-model"],
    });
    const models = await runWithRuntime(reg.codec.modelCatalog);

    expect(models).toEqual(["custom/codex-model"]);
  });
});

describe("createPiAcpDriverRegistration", () => {
  it("returns empty models when no home directory is provided", async () => {
    const reg = createPiAcpDriverRegistration();
    const models = await runWithRuntime(reg.codec.modelCatalog);

    expect(models).toEqual([]);
    expect(reg.runtime).toBeDefined();
    expect(reg.description).toBe("Pi ACP driver");
  });

  it("allows custom model override", async () => {
    const reg = createPiAcpDriverRegistration({
      models: ["pi/custom-model"],
    });
    const models = await runWithRuntime(reg.codec.modelCatalog);

    expect(models).toEqual(["pi/custom-model"]);
  });
});
