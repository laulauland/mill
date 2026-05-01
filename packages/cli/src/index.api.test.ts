import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { runCli } from "./index";

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

const TEST_HARNESS_ENV = {
  ...TEST_ACP_ENV,
  CODEX_THREAD_ID: "test-thread-id",
} as const;

const runCliForTest = async (
  argv: ReadonlyArray<string>,
  options?: Parameters<typeof runCli>[1],
): Promise<number> => {
  const previousDepth = process.env.MILL_RUN_DEPTH;

  delete process.env.MILL_RUN_DEPTH;

  try {
    return await runCli(argv, {
      ...options,
      env: {
        ...TEST_HARNESS_ENV,
        ...options?.env,
      },
    });
  } finally {
    if (previousDepth === undefined) {
      delete process.env.MILL_RUN_DEPTH;
    } else {
      process.env.MILL_RUN_DEPTH = previousDepth;
    }
  }
};

const RunSyncEnvelope = Schema.fromJsonString(
  Schema.Struct({
    run: Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      paths: Schema.Struct({
        runDir: Schema.String,
        runFile: Schema.String,
        eventsFile: Schema.String,
        resultFile: Schema.String,
      }),
    }),
    result: Schema.Struct({
      runId: Schema.String,
      status: Schema.String,
      tasks: Schema.Array(
        Schema.Struct({
          text: Schema.String,
          sessionRef: Schema.String,
          role: Schema.String,
          model: Schema.String,
          provider: Schema.String,
          exitCode: Schema.Number,
        }),
      ),
    }),
  }),
);

const StatusEnvelope = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    paths: Schema.Struct({
      runDir: Schema.String,
      runFile: Schema.String,
      eventsFile: Schema.String,
      resultFile: Schema.String,
    }),
  }),
);

describe("runCli", () => {
  it("returns non-zero for removed discovery subcommand", async () => {
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];

    const code = await runCliForTest(["discovery", "--json"], {
      cwd: "/workspace/repo",
      homeDirectory: "/Users/tester",
      io: {
        stdout: (line) => {
          stdout.push(line);
        },
        stderr: (line) => {
          stderr.push(line);
        },
      },
    });

    expect(code).toBe(1);
    expect(stdout).toHaveLength(0);
    expect(stderr).toHaveLength(0);
  });

  it("executes run --sync and resolves status for persisted runId", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-cli-run-"));
    const homeDirectory = join(tempDirectory, "home");
    const programPath = join(tempDirectory, "program.ts");

    await writeFile(
      programPath,
      [
        'import { mill } from "@mill/core/program";',
        "const task = mill.task({",
        '  agent: { provider: "codex", model: "openai-codex/gpt-5.3-codex" },',
        '  system: "You are concise.",',
        '  prompt: "Say hello",',
        '  role: "scout",',
        "}).start();",
        "const result = await task.done;",
        "globalThis.__millLastText = result.text;",
      ].join("\n"),
      "utf-8",
    );

    const runStdout: Array<string> = [];
    const runStderr: Array<string> = [];

    try {
      const runCode = await runCliForTest(["run", programPath, "--sync", "--json"], {
        cwd: tempDirectory,
        homeDirectory,
        pathExists: async () => false,
        io: {
          stdout: (line) => {
            runStdout.push(line);
          },
          stderr: (line) => {
            runStderr.push(line);
          },
        },
      });

      expect(runCode).toBe(0);
      expect(runStderr).toHaveLength(0);
      expect(runStdout).toHaveLength(1);

      const runPayload = Schema.decodeUnknownSync(RunSyncEnvelope)(runStdout[0]);
      expect(runPayload.run.status).toBe("complete");
      expect(runPayload.result.status).toBe("complete");
      expect(runPayload.result.tasks).toHaveLength(1);

      const statusStdout: Array<string> = [];
      const statusStderr: Array<string> = [];

      const statusCode = await runCliForTest(["status", runPayload.run.id, "--json"], {
        cwd: tempDirectory,
        homeDirectory,
        pathExists: async () => false,
        io: {
          stdout: (line) => {
            statusStdout.push(line);
          },
          stderr: (line) => {
            statusStderr.push(line);
          },
        },
      });

      expect(statusCode).toBe(0);
      expect(statusStderr).toHaveLength(0);
      expect(statusStdout).toHaveLength(1);

      const statusPayload = Schema.decodeUnknownSync(StatusEnvelope)(statusStdout[0]);
      expect(statusPayload.id).toBe(runPayload.run.id);
      expect(statusPayload.status).toBe("complete");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("executes run --sync with actor-shaped mill.task", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-cli-task-run-"));
    const homeDirectory = join(tempDirectory, "home");
    const programPath = join(tempDirectory, "program.ts");

    await writeFile(
      programPath,
      [
        "const statuses = [];",
        'import { mill } from "@mill/core/program";',
        "const task = mill.task({",
        '  agent: { provider: "codex", model: "openai-codex/gpt-5.3-codex" },',
        '  prompt: "Say hello",',
        "});",
        "task.subscribe((snapshot) => statuses.push(snapshot.status));",
        "const result = await task.start().done;",
        "export default JSON.stringify({ text: result.text, status: task.getSnapshot().status, statuses });",
      ].join("\n"),
      "utf-8",
    );

    const runStdout: Array<string> = [];
    const runStderr: Array<string> = [];

    try {
      const runCode = await runCliForTest(["run", programPath, "--sync", "--json"], {
        cwd: tempDirectory,
        homeDirectory,
        pathExists: async () => false,
        io: {
          stdout: (line) => {
            runStdout.push(line);
          },
          stderr: (line) => {
            runStderr.push(line);
          },
        },
      });

      expect(runCode).toBe(0);
      expect(runStderr).toHaveLength(0);
      expect(runStdout).toHaveLength(1);

      const runPayload = Schema.decodeUnknownSync(RunSyncEnvelope)(runStdout[0]);
      expect(runPayload.run.status).toBe("complete");
      expect(runPayload.result.status).toBe("complete");
      expect(runPayload.result.tasks).toHaveLength(1);
      expect(runPayload.result.tasks[0]?.text).toBe("Hello from fake agent");

      const resultFile = JSON.parse(await readFile(runPayload.run.paths.resultFile, "utf-8")) as {
        readonly programResult?: string;
      };
      const programResult = JSON.parse(resultFile.programResult ?? "{}") as {
        readonly text?: string;
        readonly status?: string;
        readonly statuses?: ReadonlyArray<string>;
      };

      expect(programResult).toEqual({
        text: "Hello from fake agent",
        status: "complete",
        statuses: ["idle", "running", "complete"],
      });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
