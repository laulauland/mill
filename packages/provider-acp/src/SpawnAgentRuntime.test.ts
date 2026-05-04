import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { ConfigOption } from "spawn-agent";
import { resolveModelOption, SpawnAgentRuntimeError } from "./SpawnAgentRuntime";

const booleanOption = {
  id: "permission-mode",
  name: "Permission mode",
  type: "boolean",
  currentValue: true,
} satisfies ConfigOption;

const modelOption = {
  id: "model-select",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "gpt-5",
  options: [
    { value: "gpt-5", name: "GPT 5" },
    { value: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
  ],
} satisfies ConfigOption;

const groupedModelOption = {
  id: "engine",
  name: "Engine Model",
  type: "select",
  currentValue: "fast",
  options: [
    {
      group: "recommended",
      name: "Recommended",
      options: [{ value: "fast", name: "Fast Model" }],
    },
  ],
} satisfies ConfigOption;

describe("resolveModelOption", () => {
  test("returns undefined for pi default because pi-acp does not expose configOptions", async () => {
    await expect(
      Effect.runPromise(resolveModelOption([], "pi", "default")),
    ).resolves.toBeUndefined();
  });

  test("fails when no model config option exists", async () => {
    await expect(
      Effect.runPromise(resolveModelOption([booleanOption], "codex", "gpt-5")),
    ).rejects.toMatchObject({
      provider: "codex",
      model: "gpt-5",
      message: expect.stringContaining("permission-mode (Permission mode)"),
    });
  });

  test("fails when the requested model does not match available values or names", async () => {
    await expect(
      Effect.runPromise(resolveModelOption([modelOption], "codex", "missing-model")),
    ).rejects.toMatchObject({
      provider: "codex",
      model: "missing-model",
      message: expect.stringContaining("gpt-5 (GPT 5)"),
    });
  });

  test("returns config id and canonical value for exact value match", async () => {
    await expect(
      Effect.runPromise(resolveModelOption([modelOption], "codex", "gpt-5")),
    ).resolves.toEqual({ configId: "model-select", value: "gpt-5" });
  });

  test("returns config id and canonical value for case-insensitive name match", async () => {
    await expect(
      Effect.runPromise(resolveModelOption([groupedModelOption], "pi", "fast model")),
    ).resolves.toEqual({ configId: "engine", value: "fast" });
  });

  test("fails with SpawnAgentRuntimeError", async () => {
    await expect(
      Effect.runPromise(resolveModelOption([], "claude", "sonnet")),
    ).rejects.toBeInstanceOf(SpawnAgentRuntimeError);
  });
});
