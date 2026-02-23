import { describe, expect, it } from "bun:test";
import { createMill } from "./mill.api";

describe("createMill", () => {
  it("returns a Promise-based mill API backed by Effect core", async () => {
    const mill = await createMill();

    const result = await mill.spawn({
      agent: "scout",
      systemPrompt: "You are concise.",
      prompt: "Say hello",
    });

    expect(result.driver).toBe("default");
    expect(result.sessionRef).toBe("session/noop");
    expect(result.exitCode).toBe(0);
  });
});
