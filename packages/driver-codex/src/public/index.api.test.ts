import { describe, expect, it } from "bun:test";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime } from "effect";
import { createCodexDriverRegistration } from "./index.api";

const runtime = Runtime.defaultRuntime;

const CODEX_JSON_FIXTURE_SCRIPT =
  "console.log(JSON.stringify({type:'thread.started',thread_id:'codex-thread'}));" +
  "console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'ls -la'}}));" +
  "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));" +
  "console.log(JSON.stringify({type:'turn.completed'}));";

describe("createCodexDriverRegistration", () => {
  it("supports explicit model catalogs", async () => {
    const driver = createCodexDriverRegistration({
      models: ["openai/gpt-5.3-codex"],
    });
    const models = await Runtime.runPromise(runtime)(driver.codec.modelCatalog);

    expect(models).toEqual(["openai/gpt-5.3-codex"]);
    expect(driver.runtime).toBeDefined();
  });

  it("spawns runtime outputs via generic driver contracts", async () => {
    const driver = createCodexDriverRegistration({
      process: {
        command: "bun",
        args: ["-e", CODEX_JSON_FIXTURE_SCRIPT],
      },
      models: ["openai/gpt-5.3-codex"],
    });

    if (driver.runtime === undefined) {
      return;
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
    expect(output.result.sessionRef).toBe("codex-thread");
    expect(output.result.text).toBe("done");
    expect(output.events.some((event) => event.type === "tool_call")).toBe(true);
  });
});
