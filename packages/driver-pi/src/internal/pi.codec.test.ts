import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { runWithRuntime } from "../public/test-runtime.api";
import { decodePiProcessOutput } from "./pi.codec";

describe("pi codec terminal sequencing", () => {
  it("rejects duplicate terminal agent_end lines deterministically", async () => {
    const output = [
      JSON.stringify({ type: "session", id: "session-test" }),
      JSON.stringify({ type: "agent_end", messages: [] }),
      JSON.stringify({ type: "agent_end", messages: [] }),
    ].join("\n");

    const decodeError = await runWithRuntime(
      Effect.flip(
        decodePiProcessOutput(output, {
          agent: "scout",
          model: "openai/gpt-5.3-codex",
          spawnId: "spawn_test",
        }),
      ),
    );

    expect(decodeError).toMatchObject({
      _tag: "PiCodecError",
    });
  });

  it("rejects non-terminal lines emitted after terminal agent_end", async () => {
    const output = [
      JSON.stringify({ type: "agent_end", messages: [] }),
      JSON.stringify({ type: "tool_execution_start", toolName: "bash" }),
    ].join("\n");

    const decodeError = await runWithRuntime(
      Effect.flip(
        decodePiProcessOutput(output, {
          agent: "scout",
          model: "openai/gpt-5.3-codex",
          spawnId: "spawn_test",
        }),
      ),
    );

    expect(decodeError).toMatchObject({
      _tag: "PiCodecError",
    });
  });
});
