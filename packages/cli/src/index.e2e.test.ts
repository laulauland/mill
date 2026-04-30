import { describe, expect, it } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const FAKE_ACP_AGENT_SCRIPT = `
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
    write({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "test-session-123" }});
    return;
  }

  if (msg.method === "session/prompt") {
    const sessionId = msg.params?.sessionId || "test-session-123";
    write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello from " } } }});
    write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fake agent" } } }});
    write({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" }});
    return;
  }

  if (msg.method === "session/close") {
    write({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
`;

const TEST_ACP_ENV = {
  MILL_ACP_COMMAND: "bun",
  MILL_ACP_ARGS_JSON: JSON.stringify(["-e", FAKE_ACP_AGENT_SCRIPT]),
} as const;

const makeCommand = (command: string, ...args: ReadonlyArray<string>): ChildProcess.Command =>
  ChildProcess.make(command, args);

const envCommand = (
  command: ChildProcess.Command,
  env: Readonly<Record<string, string | undefined>>,
): ChildProcess.Command => {
  if (!ChildProcess.isStandardCommand(command)) {
    return command;
  }

  return ChildProcess.make(command.command, command.args, {
    ...command.options,
    env: {
      ...command.options.env,
      ...env,
    },
    extendEnv: true,
  });
};

const withNeutralRunDepthEnv = (command: ChildProcess.Command): ChildProcess.Command =>
  envCommand(command, {
    ...TEST_ACP_ENV,
    HOME: "",
    MILL_RUN_DEPTH: "",
  });

const commandOutput = (command: ChildProcess.Command): Promise<string> =>
  Effect.runPromise(
    Effect.provide(
      ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
        spawner.string(withNeutralRunDepthEnv(command)),
      ),
      BunServices.layer,
    ),
  );

const commandExitCode = (command: ChildProcess.Command): Promise<number> =>
  Effect.runPromise(
    Effect.provide(
      Effect.map(
        ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
          spawner.exitCode(withNeutralRunDepthEnv(command)),
        ),
        Number,
      ),
      BunServices.layer,
    ),
  );

describe("mill help (e2e)", () => {
  it("does not expose discovery subcommand", async () => {
    const exitCode = await commandExitCode(
      makeCommand("bun", "run", "packages/cli/src/mill.ts", "discovery", "--json"),
    );

    expect(exitCode).toBe(1);
  });

  it("prints top-level help via built-in --help", async () => {
    const output = await commandOutput(
      makeCommand("bun", "run", "packages/cli/src/mill.ts", "--help"),
    );

    expect(output).toContain("Usage: mill <command>");
    expect(output).toContain("Commands:");
    expect(output).toContain("run <program.ts>");
    expect(output).not.toContain("inspect <ref>");
    expect(output).not.toContain("discovery");
    expect(output).not.toContain("Effect-first");
  });

  it("prints per-command help via built-in --help", async () => {
    const output = await commandOutput(
      makeCommand("bun", "run", "packages/cli/src/mill.ts", "run", "--help"),
    );

    expect(output).toContain("$ run [--json] [--sync]");
    expect(output).not.toContain(`--${"driver"}`);
    expect(output).not.toContain(`--${"executor"}`);
  });
});

describe("mill run/status/wait (e2e)", () => {});
