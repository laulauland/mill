import { describe, expect, it } from "bun:test";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime } from "effect";
import { createCodexDriverRegistration } from "./index.api";

const runtime = Runtime.defaultRuntime;

describe("createCodexDriverRegistration", () => {
  it("exposes catalog-backed model discovery", async () => {
    const driver = createCodexDriverRegistration();
    const models = await Runtime.runPromise(runtime)(driver.codec.modelCatalog);

    expect(models).toEqual(["openai/gpt-5.3-codex"]);
    expect(driver.runtime).toBeDefined();
  });

  it("spawns runtime outputs via generic driver contracts", async () => {
    const driver = createCodexDriverRegistration();

    if (driver.runtime === undefined) {
      throw new Error("driver runtime is required");
    }

    const output = await Runtime.runPromise(runtime)(
      Effect.provide(
        driver.runtime.spawn({
          runId: "run_codex_test",
          spawnId: "spawn_codex_test",
          agent: "scout",
          systemPrompt: "You are concise.",
          prompt: "Say hello",
          model: "openai/gpt-5.3-codex",
        }),
        BunContext.layer,
      ),
    );

    expect(output.result.driver).toBe("codex");
    expect(output.result.sessionRef.length).toBeGreaterThan(0);
  });
});
