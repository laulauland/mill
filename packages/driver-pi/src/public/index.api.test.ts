import { describe, expect, it } from "bun:test";
import { Runtime } from "effect";
import { createPiDriverRegistration } from "./index.api";

const runtime = Runtime.defaultRuntime;

describe("createPiDriverRegistration", () => {
  it("exposes catalog-backed model discovery via codec", async () => {
    const driver = createPiDriverRegistration();

    const models = await Runtime.runPromise(runtime)(driver.codec.modelCatalog);

    expect(models).toEqual(["openai/gpt-5.3-codex", "anthropic/claude-sonnet-4-6"]);
    expect(driver.process.command).toBe("pi");
    expect(driver.process.args).toEqual(["-p"]);
  });
});
