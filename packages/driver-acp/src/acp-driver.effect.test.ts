import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const MULTI_TURN_ACP_AGENT_SCRIPT = `
const fs = require("node:fs");
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const record = (event) => {
  if (process.env.MILL_TEST_LOG) {
    fs.appendFileSync(process.env.MILL_TEST_LOG, JSON.stringify(event) + "\\n");
  }
};

let selectedModel = "unset";
let pendingPromptId;
const sessionId = "multi-turn-session";
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
      agentCapabilities: { promptCapabilities: {}, sessionCapabilities: { close: {}, cancel: {} } },
      agentInfo: { name: "fake-agent", version: "0.0.1" },
      authMethods: []
    }});
    return;
  }

  if (msg.method === "session/new") {
    record({ method: "session/new" });
    write({ jsonrpc: "2.0", id: msg.id, result: { sessionId, configOptions }});
    return;
  }

  if (msg.method === "session/set_config_option") {
    selectedModel = msg.params?.value || "missing";
    record({ method: "session/set_config_option", value: selectedModel });
    write({ jsonrpc: "2.0", id: msg.id, result: { configOptions }});
    return;
  }

  if (msg.method === "session/prompt") {
    const rawPrompt = msg.params?.prompt?.[0]?.text || msg.params?.prompt || "missing prompt";
    const prompt = typeof rawPrompt === "string" && rawPrompt.includes("\\n\\n")
      ? rawPrompt.split("\\n\\n").at(-1)
      : rawPrompt;
    record({ method: "session/prompt", sessionId: msg.params?.sessionId, prompt });
    write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: prompt + " via " + selectedModel } } }});
    if (prompt === "slow prompt") {
      pendingPromptId = msg.id;
      return;
    }
    write({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" }});
    return;
  }

  if (msg.method === "session/cancel" || msg.method === "session/prompt/cancel") {
    record({ method: msg.method, sessionId: msg.params?.sessionId });
    if (pendingPromptId !== undefined) {
      write({ jsonrpc: "2.0", id: pendingPromptId, result: { stopReason: "cancelled" }});
      pendingPromptId = undefined;
    }
    if (msg.id !== undefined) {
      write({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
    return;
  }

  if (msg.method === "session/close") {
    record({ method: "session/close", sessionId: msg.params?.sessionId });
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

  it("supports multiple turns on one ACP session and closes it", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "mill-acp-session-"));
    const logPath = join(tempDirectory, "events.ndjson");

    try {
      const driver = makeAcpDriver("test-acp", {
        command: "bun",
        args: ["-e", MULTI_TURN_ACP_AGENT_SCRIPT],
        env: { MILL_TEST_LOG: logPath },
      });

      const session = await runEffect(
        driver.createTaskSession!({
          runId: "run_multi",
          runDirectory: tempDirectory,
          taskId: "task_multi",
          agent: "scout",
          systemPrompt: "You are concise.",
          model: "test/model",
        }),
      );

      const first = await runEffect(session.startTurn({ prompt: "first prompt" }));
      const second = await runEffect(session.startTurn({ prompt: "second prompt" }));
      await runEffect(session.close());

      expect(session.sessionRef).toBe("multi-turn-session");
      expect(first.result.sessionRef).toBe("multi-turn-session");
      expect(first.result.text).toBe("first prompt via test/model");
      expect(second.result.sessionRef).toBe("multi-turn-session");
      expect(second.result.text).toBe("second prompt via test/model");
      expect(second.result.driver).toBe("test-acp");

      const records = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(records.filter((record) => record.method === "session/new")).toHaveLength(1);
      expect(records.filter((record) => record.method === "session/prompt")).toEqual([
        { method: "session/prompt", sessionId: "multi-turn-session", prompt: "first prompt" },
        { method: "session/prompt", sessionId: "multi-turn-session", prompt: "second prompt" },
      ]);
      expect(records.some((record) => record.method === "session/close")).toBe(true);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  }, 15000);

  it("exposes best-effort task session cancellation", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "mill-acp-cancel-"));
    const logPath = join(tempDirectory, "events.ndjson");

    try {
      const driver = makeAcpDriver("test-acp", {
        command: "bun",
        args: ["-e", MULTI_TURN_ACP_AGENT_SCRIPT],
        env: { MILL_TEST_LOG: logPath },
      });

      const session = await runEffect(
        driver.createTaskSession!({
          runId: "run_cancel_turn",
          runDirectory: tempDirectory,
          taskId: "task_cancel_turn",
          agent: "scout",
          systemPrompt: "You are concise.",
          model: "test/model",
        }),
      );

      const turnPromise = runEffect(session.startTurn({ prompt: "slow prompt" }));
      await Bun.sleep(20);
      await runEffect(session.cancelTurn("user interrupt"));
      const cancelledTurn = await turnPromise;
      await runEffect(session.close());

      expect(cancelledTurn.result.stopReason).toBe("cancelled");

      const records = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(
        records.some(
          (record) =>
            record.method === "session/cancel" || record.method === "session/prompt/cancel",
        ),
      ).toBe(true);
      expect(records.some((record) => record.method === "session/close")).toBe(true);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
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
