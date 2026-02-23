import { describe, expect, it } from "bun:test";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime } from "effect";
import { createClaudeDriverRegistration } from "./index.api";

const runtime = Runtime.defaultRuntime;

describe("createClaudeDriverRegistration", () => {
  it("exposes catalog-backed model discovery", async () => {
    const driver = createClaudeDriverRegistration();
    const models = await Runtime.runPromise(runtime)(driver.codec.modelCatalog);

    expect(models).toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(driver.runtime).toBeDefined();
  });

  it("spawns runtime outputs via generic driver contracts", async () => {
    const driver = createClaudeDriverRegistration();

    if (driver.runtime === undefined) {
      throw new Error("driver runtime is required");
    }

    const output = await Runtime.runPromise(runtime)(
      Effect.provide(
        driver.runtime.spawn({
          runId: "run_claude_test",
          spawnId: "spawn_claude_test",
          agent: "scout",
          systemPrompt: "You are concise.",
          prompt: "Say hello",
          model: "anthropic/claude-sonnet-4-6",
        }),
        BunContext.layer,
      ),
    );

    expect(output.result.driver).toBe("claude");
    expect(output.result.sessionRef.length).toBeGreaterThan(0);
  });
});
