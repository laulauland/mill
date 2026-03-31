import { describe, expect, it } from "bun:test";
import { runEffect } from "./test-runtime";
import { makeAcpDriver } from "./acp-driver.effect";

const FAKE_ACP_AGENT_SCRIPT = `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === "initialize") {
    write({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "0.1",
      serverInfo: { name: "fake-agent", version: "0.0.1" },
      capabilities: {}
    }});
    return;
  }

  if (msg.method === "session/new") {
    write({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "test-session-123" }});
    return;
  }

  if (msg.method === "session/prompt") {
    const sessionId = msg.params?.sessionId || "test-session-123";
    write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, sessionUpdate: "agent_message_chunk", text: "Hello from " }});
    write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, sessionUpdate: "agent_message_chunk", text: "fake agent" }});
    write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, sessionUpdate: "tool_call", name: "read_file", toolCallId: "tc-1", input: {} }});
    write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, sessionUpdate: "agent_thought_chunk", text: "thinking..." }});
    write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, sessionUpdate: "plan", steps: ["step 1", "step 2"] }});
    write({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" }});
    return;
  }

  if (msg.method === "session/cancel") {
    return;
  }
});
`;

const makeVariantAgentScript = (stopReason: string): string => `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === "initialize") {
    write({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "0.1",
      serverInfo: { name: "fake-agent", version: "0.0.1" },
      capabilities: {}
    }});
    return;
  }

  if (msg.method === "session/new") {
    write({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "test-session-variant" }});
    return;
  }

  if (msg.method === "session/prompt") {
    write({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "${stopReason}" }});
    return;
  }
});
`;

describe("makeAcpDriver", () => {
  it("spawns and collects ACP session output", async () => {
    const driver = makeAcpDriver("test-acp", {
      command: "bun",
      args: ["-e", FAKE_ACP_AGENT_SCRIPT],
    });

    const output = await runEffect(
      driver.spawn({
        runId: "run_test",
        runDirectory: "/tmp/run_test",
        spawnId: "spawn_test",
        agent: "scout",
        systemPrompt: "You are concise.",
        prompt: "Say hello",
        model: "test/model",
      }),
    );

    expect(output.result.text).toBe("Hello from fake agent");
    expect(output.result.sessionRef).toBe("test-session-123");
    expect(output.result.driver).toBe("test-acp");
    expect(output.result.exitCode).toBe(0);
    expect(output.result.stopReason).toBeUndefined();
    expect(output.events.some((e) => e.type === "tool_call")).toBe(true);
    expect(output.events.some((e) => e.type === "message_chunk")).toBe(true);
    expect(output.events.some((e) => e.type === "thought_chunk")).toBe(true);
    expect(output.events.some((e) => e.type === "plan")).toBe(true);
  }, 15000);

  it("handles refusal stop reason", async () => {
    const driver = makeAcpDriver("test-acp", {
      command: "bun",
      args: ["-e", makeVariantAgentScript("refusal")],
    });

    const output = await runEffect(
      driver.spawn({
        runId: "run_refusal",
        runDirectory: "/tmp/run_refusal",
        spawnId: "spawn_refusal",
        agent: "scout",
        systemPrompt: "You are concise.",
        prompt: "Say hello",
        model: "test/model",
      }),
    );

    expect(output.result.exitCode).toBe(1);
    expect(output.result.stopReason).toBe("refusal");
  }, 15000);

  it("handles cancelled stop reason", async () => {
    const driver = makeAcpDriver("test-acp", {
      command: "bun",
      args: ["-e", makeVariantAgentScript("cancelled")],
    });

    const output = await runEffect(
      driver.spawn({
        runId: "run_cancelled",
        runDirectory: "/tmp/run_cancelled",
        spawnId: "spawn_cancelled",
        agent: "scout",
        systemPrompt: "You are concise.",
        prompt: "Say hello",
        model: "test/model",
      }),
    );

    expect(output.result.exitCode).toBe(1);
    expect(output.result.stopReason).toBe("cancelled");
  }, 15000);

  it("resolveSession returns correct pointer", async () => {
    const driver = makeAcpDriver("claude", { command: "echo", args: [] });

    const pointer = await runEffect(driver.resolveSession!({ sessionRef: "session-abc" }));

    expect(pointer.driver).toBe("claude");
    expect(pointer.sessionRef).toBe("session-abc");
    expect(pointer.pointer).toContain("acp://claude/session/");
  });
});
