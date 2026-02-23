import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { runWithRuntime } from "../public/test-runtime.api";
import { decodePiProcessOutput } from "./pi.codec";

describe("pi codec terminal sequencing", () => {
  it("rejects duplicate final lines deterministically", async () => {
    const output = [
      JSON.stringify({ type: "milestone", message: "start" }),
      JSON.stringify({
        type: "final",
        text: "done",
        sessionRef: "session/scout",
        agent: "scout",
        model: "openai/gpt-5.3-codex",
        exitCode: 0,
      }),
      JSON.stringify({
        type: "final",
        text: "done-again",
        sessionRef: "session/scout",
        agent: "scout",
        model: "openai/gpt-5.3-codex",
        exitCode: 0,
      }),
    ].join("\n");

    const decodeError = await runWithRuntime(Effect.flip(decodePiProcessOutput(output)));

    expect(decodeError).toMatchObject({
      _tag: "PiCodecError",
    });
  });

  it("rejects non-terminal lines emitted after final terminal", async () => {
    const output = [
      JSON.stringify({
        type: "final",
        text: "done",
        sessionRef: "session/scout",
        agent: "scout",
        model: "openai/gpt-5.3-codex",
        exitCode: 0,
      }),
      JSON.stringify({ type: "tool_call", toolName: "grep" }),
    ].join("\n");

    const decodeError = await runWithRuntime(Effect.flip(decodePiProcessOutput(output)));

    expect(decodeError).toMatchObject({
      _tag: "PiCodecError",
    });
  });
});
