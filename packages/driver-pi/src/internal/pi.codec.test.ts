import { describe, expect, it } from "bun:test";
import { runWithRuntime } from "../public/test-runtime.api";
import { decodePiProcessOutput } from "./pi.codec";

describe("pi codec terminal sequencing", () => {
  it("uses the last agent_end payload when multiple terminal events are emitted", async () => {
    const output = [
      JSON.stringify({ type: "session", id: "session-test" }),
      JSON.stringify({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: "first" }] }],
      }),
      JSON.stringify({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: "second" }] }],
      }),
    ].join("\n");

    const decoded = await runWithRuntime(
      decodePiProcessOutput(output, {
        agent: "scout",
        model: "openai/gpt-5.3-codex",
        spawnId: "spawn_test",
      }),
    );

    expect(decoded.result.text).toBe("second");
  });

  it("tolerates non-terminal retry events emitted after agent_end", async () => {
    const output = [
      JSON.stringify({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      }),
      JSON.stringify({ type: "auto_retry_start" }),
    ].join("\n");

    const decoded = await runWithRuntime(
      decodePiProcessOutput(output, {
        agent: "scout",
        model: "openai/gpt-5.3-codex",
        spawnId: "spawn_test",
      }),
    );

    expect(decoded.result.text).toBe("done");
  });

  it("marks stopReason=error payloads as failed spawn results", async () => {
    const output = [
      JSON.stringify({ type: "session", id: "session-test" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "context_length_exceeded",
        },
      }),
      JSON.stringify({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "context_length_exceeded",
          },
        ],
      }),
    ].join("\n");

    const decoded = await runWithRuntime(
      decodePiProcessOutput(output, {
        agent: "scout",
        model: "openai/gpt-5.3-codex",
        spawnId: "spawn_test",
      }),
    );

    expect(decoded.result.exitCode).toBe(1);
    expect(decoded.result.stopReason).toBe("error");
    expect(decoded.result.errorMessage).toBe("context_length_exceeded");
  });
});
