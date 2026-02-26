import { describe, expect, it } from "bun:test";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime } from "effect";
import { createClaudeDriverRegistration } from "./index.api";

const runtime = Runtime.defaultRuntime;

const CLAUDE_JSON_FIXTURE_SCRIPT =
  "console.log(JSON.stringify({type:'system',session_id:'claude-session'}));" +
  "console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Bash'},{type:'text',text:'Working...'}]}}));" +
  "console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done',stop_reason:'stop',session_id:'claude-session'}));";

describe("createClaudeDriverRegistration", () => {
  it("supports explicit model catalogs", async () => {
    const driver = createClaudeDriverRegistration({
      models: [" anthropic/claude-sonnet-4-6 ", "anthropic/claude-sonnet-4-6", ""],
    });
    const models = await Runtime.runPromise(runtime)(driver.codec.modelCatalog);

    expect(models).toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(driver.runtime).toBeDefined();
  });

  it("provides a non-empty default catalog", async () => {
    const driver = createClaudeDriverRegistration();
    const models = await Runtime.runPromise(runtime)(driver.codec.modelCatalog);

    expect(models).toContain("anthropic/claude-sonnet-4-6");
  });

  it("spawns runtime outputs via generic driver contracts", async () => {
    const driver = createClaudeDriverRegistration({
      process: {
        command: "bun",
        args: ["-e", CLAUDE_JSON_FIXTURE_SCRIPT],
      },
      models: ["anthropic/claude-sonnet-4-6"],
    });

    if (driver.runtime === undefined) {
      return;
    }

    const output = await Runtime.runPromise(runtime)(
      Effect.provide(
        driver.runtime.spawn({
          runId: "run_claude_test",
          runDirectory: "/tmp/run_claude_test",
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
    expect(output.result.sessionRef).toBe("claude-session");
    expect(output.events.some((event) => event.type === "tool_call")).toBe(true);
  });
});
