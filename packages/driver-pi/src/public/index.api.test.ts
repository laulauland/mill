import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime } from "effect";
import { createPiDriverRegistration } from "./index.api";

const runtime = Runtime.defaultRuntime;

const PI_JSON_FIXTURE_SCRIPT =
  "const args=process.argv.slice(1);" +
  "const modelIndex=args.indexOf('--model');" +
  "const model=modelIndex>=0?args[modelIndex+1]:'openai/gpt-5.3-codex';" +
  "const prompt=args[args.length-1]??'';" +
  "const text='fixture:'+model+':'+prompt;" +
  "console.log(JSON.stringify({type:'session',id:'session-test'}));" +
  "console.log(JSON.stringify({type:'agent_start'}));" +
  "console.log(JSON.stringify({type:'tool_execution_start',toolName:'bash'}));" +
  "console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],model,stopReason:'stop'}}));" +
  "console.log(JSON.stringify({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text}],model,stopReason:'stop'}]}));";

const DUPLICATE_TERMINAL_SCRIPT =
  "console.log(JSON.stringify({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text:'first'}]}]}));" +
  "console.log(JSON.stringify({type:'auto_retry_start'}));" +
  "console.log(JSON.stringify({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text:'second'}]}]}));";

const ERROR_TERMINAL_SCRIPT =
  "console.log(JSON.stringify({type:'session',id:'session-test'}));" +
  "console.log(JSON.stringify({type:'agent_end',messages:[{role:'assistant',content:[],stopReason:'error',errorMessage:'context_length_exceeded'}]}));";

describe("createPiDriverRegistration", () => {
  it("supports explicit model catalog overrides via codec", async () => {
    const driver = createPiDriverRegistration({
      models: [" openai/gpt-5.3-codex ", "openai/gpt-5.3-codex", ""],
    });

    const models = await Runtime.runPromise(runtime)(driver.codec.modelCatalog);

    expect(models).toEqual(["openai/gpt-5.3-codex"]);
    expect(driver.process.command.length).toBeGreaterThan(0);
    expect(driver.process.args.length).toBeGreaterThan(0);
  });

  it("reads model catalog from ~/.pi/agent/settings.json when override is omitted", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-driver-pi-model-catalog-"));
    const homeDirectory = join(tempDirectory, "home");
    const settingsPath = join(homeDirectory, ".pi", "agent", "settings.json");
    const previousHome = process.env.HOME;

    try {
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify(
          {
            enabledModels: [
              " openai/gpt-5.3-codex ",
              "cerebras/zai-glm-4.7",
              "",
              "cerebras/zai-glm-4.7",
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      process.env.HOME = homeDirectory;

      const driver = createPiDriverRegistration();
      const models = await Runtime.runPromise(runtime)(driver.codec.modelCatalog);

      expect(models).toEqual(["openai/gpt-5.3-codex", "cerebras/zai-glm-4.7"]);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }

      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("spawns process-backed runs and decodes structured pi JSON output", async () => {
    const driver = createPiDriverRegistration({
      process: {
        command: "bun",
        args: ["-e", PI_JSON_FIXTURE_SCRIPT, "--"],
      },
      models: ["openai/gpt-5.3-codex"],
    });

    expect(driver.runtime).toBeDefined();

    if (driver.runtime === undefined) {
      return;
    }

    const output = await Runtime.runPromise(runtime)(
      Effect.provide(
        driver.runtime.spawn({
          runId: "run_driver_test",
          runDirectory: "/tmp/run_driver_test",
          spawnId: "spawn_driver_test",
          agent: "scout",
          systemPrompt: "You are concise.",
          prompt: "Say hello",
          model: "openai/gpt-5.3-codex",
        }),
        BunContext.layer,
      ),
    );

    expect(output.events.some((event) => event.type === "tool_call")).toBe(true);
    expect(output.result.sessionRef).toBe("/tmp/run_driver_test/sessions/spawn_driver_test.jsonl");
    expect(output.result.agent).toBe("scout");
    expect(output.result.model).toBe("openai/gpt-5.3-codex");
    expect(output.result.text).toBe("fixture:openai/gpt-5.3-codex:Say hello");
    expect(output.result.exitCode).toBe(0);
    expect(output.raw?.length ?? 0).toBeGreaterThan(0);
  });

  it("resolves session pointers for inspect --session bridge", async () => {
    const driver = createPiDriverRegistration({
      models: ["openai/gpt-5.3-codex"],
    });

    expect(driver.runtime).toBeDefined();

    if (driver.runtime === undefined) {
      return;
    }

    expect(driver.runtime.resolveSession).toBeDefined();

    if (driver.runtime.resolveSession === undefined) {
      return;
    }

    const session = await Runtime.runPromise(runtime)(
      Effect.provide(
        driver.runtime.resolveSession({ sessionRef: "session/scout" }),
        BunContext.layer,
      ),
    );

    expect(session.sessionRef).toBe("session/scout");
    expect(session.driver).toBe("pi");
    expect(session.pointer.length).toBeGreaterThan(0);
  });

  it("accepts retry-style output and uses the last terminal payload", async () => {
    const driver = createPiDriverRegistration({
      process: {
        command: "bun",
        args: ["-e", DUPLICATE_TERMINAL_SCRIPT, "--"],
      },
      models: ["openai/gpt-5.3-codex"],
    });

    expect(driver.runtime).toBeDefined();

    if (driver.runtime === undefined) {
      return;
    }

    const output = await Runtime.runPromise(runtime)(
      Effect.provide(
        driver.runtime.spawn({
          runId: "run_driver_duplicate",
          runDirectory: "/tmp/run_driver_duplicate",
          spawnId: "spawn_driver_duplicate",
          agent: "scout",
          systemPrompt: "You are concise.",
          prompt: "Say hello",
          model: "openai/gpt-5.3-codex",
        }),
        BunContext.layer,
      ),
    );

    expect(output.result.text).toBe("second");
  });

  it("marks terminal stopReason=error payloads as failed", async () => {
    const driver = createPiDriverRegistration({
      process: {
        command: "bun",
        args: ["-e", ERROR_TERMINAL_SCRIPT, "--"],
      },
      models: ["openai/gpt-5.3-codex"],
    });

    expect(driver.runtime).toBeDefined();

    if (driver.runtime === undefined) {
      return;
    }

    const output = await Runtime.runPromise(runtime)(
      Effect.provide(
        driver.runtime.spawn({
          runId: "run_driver_error",
          runDirectory: "/tmp/run_driver_error",
          spawnId: "spawn_driver_error",
          agent: "scout",
          systemPrompt: "You are concise.",
          prompt: "Say hello",
          model: "openai/gpt-5.3-codex",
        }),
        BunContext.layer,
      ),
    );

    expect(output.result.exitCode).toBe(1);
    expect(output.result.stopReason).toBe("error");
    expect(output.result.errorMessage).toBe("context_length_exceeded");
  });
});
