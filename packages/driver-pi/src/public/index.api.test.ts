import { describe, expect, it } from "bun:test";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime } from "effect";
import { createPiDriverRegistration } from "./index.api";

const runtime = Runtime.defaultRuntime;

const DUPLICATE_TERMINAL_SCRIPT =
  "const input=JSON.parse(process.argv[1]);" +
  "console.log(JSON.stringify({type:'milestone',message:'spawn:'+input.agent}));" +
  "console.log(JSON.stringify({type:'final',text:'ok',sessionRef:'session/'+input.agent,agent:input.agent,model:input.model,exitCode:0}));" +
  "console.log(JSON.stringify({type:'final',text:'duplicate',sessionRef:'session/'+input.agent,agent:input.agent,model:input.model,exitCode:0}));";

describe("createPiDriverRegistration", () => {
  it("exposes catalog-backed model discovery via codec", async () => {
    const driver = createPiDriverRegistration();

    const models = await Runtime.runPromise(runtime)(driver.codec.modelCatalog);

    expect(models).toEqual(["openai/gpt-5.3-codex", "anthropic/claude-sonnet-4-6"]);
    expect(driver.process.command.length).toBeGreaterThan(0);
    expect(driver.process.args.length).toBeGreaterThan(0);
  });

  it("spawns process-backed runs and decodes structured result payload", async () => {
    const driver = createPiDriverRegistration();

    expect(driver.runtime).toBeDefined();

    if (driver.runtime === undefined) {
      return;
    }

    const output = await Runtime.runPromise(runtime)(
      Effect.provide(
        driver.runtime.spawn({
          runId: "run_driver_test",
          spawnId: "spawn_driver_test",
          agent: "scout",
          systemPrompt: "You are concise.",
          prompt: "Say hello",
          model: "openai/gpt-5.3-codex",
        }),
        BunContext.layer,
      ),
    );

    expect(output.events.length).toBeGreaterThan(0);
    expect(output.result.sessionRef.length).toBeGreaterThan(0);
    expect(output.result.agent).toBe("scout");
    expect(output.result.model).toBe("openai/gpt-5.3-codex");
    expect(output.result.exitCode).toBe(0);
  });

  it("rejects malformed duplicate terminal output fixtures", async () => {
    const driver = createPiDriverRegistration({
      process: {
        command: "bun",
        args: ["-e", DUPLICATE_TERMINAL_SCRIPT],
      },
    });

    expect(driver.runtime).toBeDefined();

    if (driver.runtime === undefined) {
      return;
    }

    const spawnError = await Runtime.runPromise(runtime)(
      Effect.provide(
        Effect.flip(
          driver.runtime.spawn({
            runId: "run_driver_duplicate",
            spawnId: "spawn_driver_duplicate",
            agent: "scout",
            systemPrompt: "You are concise.",
            prompt: "Say hello",
            model: "openai/gpt-5.3-codex",
          }),
        ),
        BunContext.layer,
      ),
    );

    expect(spawnError).toMatchObject({
      _tag: "PiProcessDriverError",
    });
  });
});
