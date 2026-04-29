import { describe, expect, it } from "bun:test";
import { runEffect } from "./test-runtime";
import { makeAcpDriver } from "./acp-driver.effect";

const FAKE_ACP_AGENT_SCRIPT = `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

let selectedModel = "unset";
const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "test/default",
    options: [
      { value: "test/default", name: "Default" },
      { value: "test/model", name: "Requested" }
    ]
  }
];

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === "initialize") {
    write({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: {},
        sessionCapabilities: { close: {} }
      },
      agentInfo: { name: "fake-agent", version: "0.0.1" },
      authMethods: []
    }});
    return;
  }

  if (msg.method === "session/new") {
    write({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "test-session-123", configOptions }});
    return;
  }

  if (msg.method === "session/set_config_option") {
    selectedModel = msg.params?.value || "missing";
    write({ jsonrpc: "2.0", id: msg.id, result: { configOptions }});
    return;
  }

  if (msg.method === "session/prompt") {
    const sessionId = msg.params?.sessionId || "test-session-123";
    write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello from " } } }});
    write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fake agent using " + selectedModel } } }});
    write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "read_file", kind: "read", status: "pending" } }});
    write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking..." } } }});
    write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "plan", entries: [{ content: "step 1", priority: "medium", status: "pending" }, { content: "step 2", priority: "medium", status: "pending" }] } }});
    write({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" }});
    return;
  }

  if (msg.method === "session/close") {
    write({ jsonrpc: "2.0", id: msg.id, result: {} });
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
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: {}, sessionCapabilities: { close: {} } },
      agentInfo: { name: "fake-agent", version: "0.0.1" },
      authMethods: []
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

  if (msg.method === "session/close") {
    write({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
});
`;

describe("makeAcpDriver", () => {
  it("spawns, selects ACP model config, and collects session output", async () => {
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

    expect(output.result.text).toBe("Hello from fake agent using test/model");
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
    const driver = makeAcpDriver("claude");

    const pointer = await runEffect(driver.resolveSession!({ sessionRef: "session-abc" }));

    expect(pointer.driver).toBe("claude");
    expect(pointer.sessionRef).toBe("session-abc");
    expect(pointer.pointer).toContain("acp://claude/session/");
  });
});
