import { describe, expect, it } from "bun:test";
import { createMill } from "./mill.api";
import { codex } from "./task.api";

describe("createMill", () => {
  it("supports task vocabulary through the Promise API", async () => {
    const mill = await createMill();

    const result = await mill.task({
      agent: codex("openai-codex/gpt-5.3-codex"),
      system: "You are concise.",
      prompt: "Say hello",
      role: "scout",
    });

    expect(result.role).toBe("scout");
    expect(result.model).toBe("openai-codex/gpt-5.3-codex");
    expect(result.driver).toBe("codex");
  });

  it("creates task actors without starting them", async () => {
    const mill = await createMill();

    const task = mill.taskActor({
      agent: codex("openai-codex/gpt-5.3-codex"),
      prompt: "Say hello",
      role: "scout",
    });

    expect(task.getSnapshot().status).toBe("idle");

    task.start();
    const result = await task.done;

    expect(result.role).toBe("scout");
    expect(task.getSnapshot().status).toBe("complete");
  });
});
