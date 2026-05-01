import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Schema from "effect/Schema";
import { Effect, Layer } from "effect";
import { createMillRuntime, type AgentRuntime } from "@mill/core";
import { CliAgentRuntimes, runCli, runCliEffect } from "./index";

const makeFakeAgentRuntime = (name: string): AgentRuntime => ({
  name,
  createSession: (input) =>
    Effect.succeed({
      sessionRef: `session/${name}/${input.role}`,
      startTurn: () =>
        Effect.succeed({
          events: [
            { type: "message_chunk", text: "Hello from " },
            { type: "message_chunk", text: "fake agent" },
          ],
          result: {
            text: "Hello from fake agent",
            sessionRef: `session/${name}/${input.role}`,
            role: input.role,
            model: input.model,
            provider: name,
            exitCode: 0,
          },
        }),
      cancelTurn: () => Effect.void,
      close: () => Effect.void,
    }),
});

const testAgentRuntimes = {
  codex: makeFakeAgentRuntime("codex"),
  claude: makeFakeAgentRuntime("claude"),
  pi: makeFakeAgentRuntime("pi"),
};

const testAgentRuntimesLayer = Layer.succeed(CliAgentRuntimes, {
  runtimes: testAgentRuntimes,
});

const TEST_HARNESS_ENV = {
  CODEX_THREAD_ID: "test-thread-id",
} as const;

const runCliForTest = async (
  argv: ReadonlyArray<string>,
  options?: Parameters<typeof runCli>[1],
): Promise<number> => {
  const previousDepth = process.env.MILL_RUN_DEPTH;

  delete process.env.MILL_RUN_DEPTH;

  try {
    return await Effect.runPromise(
      runCliEffect(argv, {
        ...options,
        env: {
          ...TEST_HARNESS_ENV,
          ...options?.env,
        },
        executablePath: options?.executablePath ?? Bun.argv[0],
        launchWorker:
          options?.launchWorker ??
          ((input) =>
            createMillRuntime({
              cwd: input.cwd,
              homeDirectory: options?.homeDirectory,
              env: {
                ...TEST_HARNESS_ENV,
                ...options?.env,
                MILL_RUN_DEPTH: String(input.runDepth),
              },
              runsDirectory: input.runsDirectory,
              agentRuntimes: testAgentRuntimes,
            })
              .worker({
                runId: input.runId,
                programPath: input.programPath,
                runDepth: input.runDepth,
              })
              .then(() => undefined)),
      }).pipe(Effect.provide(testAgentRuntimesLayer), Effect.provide(BunServices.layer)),
    );
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
  it("returns non-zero for an unknown subcommand", async () => {
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];

    const code = await runCliForTest(["unknown-command", "--json"], {
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
