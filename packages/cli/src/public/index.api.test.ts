import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "@effect/schema/Schema";
import { runCli } from "./index.api";

const DiscoveryEnvelope = Schema.parseJson(
  Schema.Struct({
    discoveryVersion: Schema.Number,
    programApi: Schema.Struct({
      spawnRequired: Schema.Array(Schema.String),
      spawnOptional: Schema.Array(Schema.String),
      resultFields: Schema.Array(Schema.String),
    }),
    drivers: Schema.Record({
      key: Schema.String,
      value: Schema.Struct({
        description: Schema.String,
        modelFormat: Schema.String,
        models: Schema.Array(Schema.String),
      }),
    }),
    authoring: Schema.Struct({
      instructions: Schema.String,
    }),
    async: Schema.Struct({
      submit: Schema.String,
      status: Schema.String,
      wait: Schema.String,
    }),
  }),
);

const RunSyncEnvelope = Schema.parseJson(
  Schema.Struct({
    run: Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      driver: Schema.String,
      executor: Schema.String,
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
      spawns: Schema.Array(
        Schema.Struct({
          text: Schema.String,
          sessionRef: Schema.String,
          agent: Schema.String,
          model: Schema.String,
          driver: Schema.String,
          exitCode: Schema.Number,
        }),
      ),
    }),
  }),
);

const RunSubmitEnvelope = Schema.parseJson(
  Schema.Struct({
    runId: Schema.String,
    status: Schema.Union(Schema.Literal("pending"), Schema.Literal("running")),
    paths: Schema.Struct({
      runDir: Schema.String,
      runFile: Schema.String,
      eventsFile: Schema.String,
      resultFile: Schema.String,
    }),
  }),
);

const StatusEnvelope = Schema.parseJson(
  Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    driver: Schema.String,
    executor: Schema.String,
    paths: Schema.Struct({
      runDir: Schema.String,
      runFile: Schema.String,
      eventsFile: Schema.String,
      resultFile: Schema.String,
    }),
  }),
);

const WaitTimeoutEnvelope = Schema.parseJson(
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      _tag: Schema.Literal("WaitTimeoutError"),
      runId: Schema.String,
      timeoutSeconds: Schema.Number,
      message: Schema.String,
    }),
  }),
);

describe("runCli", () => {
  it("writes machine payload to stdout only in --json mode", async () => {
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];

    const code = await runCli(["--help", "--json"], {
      cwd: "/workspace/repo",
      homeDirectory: "/Users/tester",
      pathExists: async () => false,
      io: {
        stdout: (line) => {
          stdout.push(line);
        },
        stderr: (line) => {
          stderr.push(line);
        },
      },
    });

    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stderr).toHaveLength(0);

    const payload = Schema.decodeUnknownSync(DiscoveryEnvelope)(stdout[0]);
    expect(payload.discoveryVersion).toBe(1);
    expect(payload.drivers.default?.models).toEqual([
      "openai/gpt-5.3-codex",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(payload.programApi.spawnRequired).toEqual(["agent", "systemPrompt", "prompt"]);
    expect(payload.drivers.codex?.models).toEqual(["openai/gpt-5.3-codex"]);
  });

  it("routes human help text to stdout in non-json mode", async () => {
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];

    const code = await runCli(["--help"], {
      cwd: "/workspace/repo",
      homeDirectory: "/Users/tester",
      pathExists: async () => false,
      io: {
        stdout: (line) => {
          stdout.push(line);
        },
        stderr: (line) => {
          stderr.push(line);
        },
      },
    });

    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stderr).toHaveLength(0);
    expect(stdout[0]).toContain("mill — Effect-first orchestration runtime");
  });

  it("executes run --sync and resolves status for persisted runId", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-cli-run-"));
    const homeDirectory = join(tempDirectory, "home");
    const programPath = join(tempDirectory, "program.ts");

    await writeFile(
      programPath,
      [
        "const scan = await mill.spawn({",
        '  agent: "scout",',
        '  systemPrompt: "You are concise.",',
        '  prompt: "Say hello",',
        "});",
        "globalThis.__millLastText = scan.text;",
      ].join("\n"),
      "utf-8",
    );

    const runStdout: Array<string> = [];
    const runStderr: Array<string> = [];

    try {
      const runCode = await runCli(["run", programPath, "--sync", "--json"], {
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
      expect(runPayload.run.driver).toBe("default");
      expect(runPayload.run.executor).toBe("direct");
      expect(runPayload.result.status).toBe("complete");
      expect(runPayload.result.spawns).toHaveLength(1);

      const statusStdout: Array<string> = [];
      const statusStderr: Array<string> = [];

      const statusCode = await runCli(["status", runPayload.run.id, "--json"], {
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
      expect(statusPayload.driver).toBe("default");
      expect(statusPayload.executor).toBe("direct");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("honors explicit --driver and --executor overrides for run --sync", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-cli-override-run-"));
    const homeDirectory = join(tempDirectory, "home");
    const programPath = join(tempDirectory, "program.ts");

    await writeFile(
      programPath,
      [
        "const scan = await mill.spawn({",
        '  agent: "scout",',
        '  systemPrompt: "You are concise.",',
        '  prompt: "Say hello",',
        "});",
        "return scan.text;",
      ].join("\n"),
      "utf-8",
    );

    try {
      const runStdout: Array<string> = [];
      const runCode = await runCli(
        ["run", programPath, "--sync", "--json", "--driver", "codex", "--executor", "vm"],
        {
          cwd: tempDirectory,
          homeDirectory,
          pathExists: async () => false,
          io: {
            stdout: (line) => {
              runStdout.push(line);
            },
            stderr: () => undefined,
          },
        },
      );

      expect(runCode).toBe(0);

      const payload = Schema.decodeUnknownSync(RunSyncEnvelope)(runStdout[0]);
      expect(payload.run.driver).toBe("codex");
      expect(payload.run.executor).toBe("vm");
      expect(payload.result.spawns[0]?.driver).toBe("codex");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("uses resolved config defaults for driver/executor when flags are omitted", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-cli-config-defaults-"));
    const homeDirectory = join(tempDirectory, "home");
    const programPath = join(tempDirectory, "program.ts");

    await writeFile(
      programPath,
      [
        "const scan = await mill.spawn({",
        '  agent: "scout",',
        '  systemPrompt: "You are concise.",',
        '  prompt: "Say hello",',
        "});",
        "return scan.text;",
      ].join("\n"),
      "utf-8",
    );

    try {
      const runStdout: Array<string> = [];
      const runCode = await runCli(["run", programPath, "--sync", "--json"], {
        cwd: tempDirectory,
        homeDirectory,
        pathExists: async (path) => path === join(tempDirectory, "mill.config.ts"),
        loadConfigOverrides: async () => ({
          defaultDriver: "claude",
          defaultExecutor: "vm",
        }),
        io: {
          stdout: (line) => {
            runStdout.push(line);
          },
          stderr: () => undefined,
        },
      });

      expect(runCode).toBe(0);

      const payload = Schema.decodeUnknownSync(RunSyncEnvelope)(runStdout[0]);
      expect(payload.run.driver).toBe("claude");
      expect(payload.run.executor).toBe("vm");
      expect(payload.result.spawns[0]?.driver).toBe("claude");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("submits run asynchronously by default and writes worker artifacts", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-cli-async-run-"));
    const homeDirectory = join(tempDirectory, "home");
    const programPath = join(tempDirectory, "program.ts");

    await writeFile(
      programPath,
      [
        "const scan = await mill.spawn({",
        '  agent: "scout",',
        '  systemPrompt: "You are concise.",',
        '  prompt: "Say hello",',
        "});",
        "globalThis.__millAsyncText = scan.text;",
      ].join("\n"),
      "utf-8",
    );

    try {
      const runStdout: Array<string> = [];
      const runStderr: Array<string> = [];

      const runCode = await runCli(["run", programPath, "--json"], {
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

      const submittedRun = Schema.decodeUnknownSync(RunSubmitEnvelope)(runStdout[0]);
      expect(submittedRun.runId.length).toBeGreaterThan(0);

      const waitStdout: Array<string> = [];
      const waitCode = await runCli(["wait", submittedRun.runId, "--timeout", "5", "--json"], {
        cwd: tempDirectory,
        homeDirectory,
        pathExists: async () => false,
        io: {
          stdout: (line) => {
            waitStdout.push(line);
          },
          stderr: () => undefined,
        },
      });

      expect(waitCode).toBe(0);
      const waitedRun = Schema.decodeUnknownSync(StatusEnvelope)(waitStdout[0]);
      expect(waitedRun.status).toBe("complete");

      const copiedProgram = await readFile(join(submittedRun.paths.runDir, "program.ts"), "utf-8");
      const workerLog = await readFile(
        join(submittedRun.paths.runDir, "logs", "worker.log"),
        "utf-8",
      );

      expect(copiedProgram).toContain("mill.spawn");
      expect(workerLog.length).toBeGreaterThan(0);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("wait returns terminal run payload with --json and human output parity", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-cli-wait-"));
    const homeDirectory = join(tempDirectory, "home");
    const programPath = join(tempDirectory, "program.ts");

    await writeFile(
      programPath,
      [
        "const scan = await mill.spawn({",
        '  agent: "scout",',
        '  systemPrompt: "You are concise.",',
        '  prompt: "Say hello",',
        "});",
        "globalThis.__millWaitText = scan.text;",
      ].join("\n"),
      "utf-8",
    );

    try {
      const runStdout: Array<string> = [];
      const runCode = await runCli(["run", programPath, "--sync", "--json"], {
        cwd: tempDirectory,
        homeDirectory,
        pathExists: async () => false,
        io: {
          stdout: (line) => {
            runStdout.push(line);
          },
          stderr: () => undefined,
        },
      });

      expect(runCode).toBe(0);
      const runPayload = Schema.decodeUnknownSync(RunSyncEnvelope)(runStdout[0]);

      const waitJsonStdout: Array<string> = [];
      const waitJsonStderr: Array<string> = [];
      const waitJsonCode = await runCli(["wait", runPayload.run.id, "--timeout", "2", "--json"], {
        cwd: tempDirectory,
        homeDirectory,
        pathExists: async () => false,
        io: {
          stdout: (line) => {
            waitJsonStdout.push(line);
          },
          stderr: (line) => {
            waitJsonStderr.push(line);
          },
        },
      });

      expect(waitJsonCode).toBe(0);
      expect(waitJsonStderr).toHaveLength(0);
      const waitJsonPayload = Schema.decodeUnknownSync(StatusEnvelope)(waitJsonStdout[0]);
      expect(waitJsonPayload.id).toBe(runPayload.run.id);
      expect(waitJsonPayload.status).toBe("complete");

      const waitHumanStdout: Array<string> = [];
      const waitHumanStderr: Array<string> = [];
      const waitHumanCode = await runCli(["wait", runPayload.run.id, "--timeout", "2"], {
        cwd: tempDirectory,
        homeDirectory,
        pathExists: async () => false,
        io: {
          stdout: (line) => {
            waitHumanStdout.push(line);
          },
          stderr: (line) => {
            waitHumanStderr.push(line);
          },
        },
      });

      expect(waitHumanCode).toBe(0);
      expect(waitHumanStderr).toHaveLength(0);
      expect(waitHumanStdout[0]).toContain(`run ${runPayload.run.id}`);
      expect(waitHumanStdout[0]).toContain("status=complete");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("creates init skeleton in cwd", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-cli-init-"));
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];

    try {
      const code = await runCli(["init"], {
        cwd: tempDirectory,
        homeDirectory: join(tempDirectory, "home"),
        io: {
          stdout: (line) => {
            stdout.push(line);
          },
          stderr: (line) => {
            stderr.push(line);
          },
        },
      });

      expect(code).toBe(0);
      expect(stderr).toHaveLength(0);
      expect(stdout[0]).toContain("mill.config.ts");

      const configSource = await readFile(join(tempDirectory, "mill.config.ts"), "utf-8");
      expect(configSource).toContain("defineConfig");
      expect(configSource).toContain("defaultExecutor");
      expect(configSource).toContain("executors");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("wait timeout is deterministic with typed JSON error contract", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-cli-wait-timeout-"));
    const runsDirectory = join(tempDirectory, "runs");
    const runId = `run_timeout_${crypto.randomUUID()}`;
    const runDir = join(runsDirectory, runId);
    const runFile = join(runDir, "run.json");
    const eventsFile = join(runDir, "events.ndjson");
    const resultFile = join(runDir, "result.json");

    await mkdir(runDir, { recursive: true });
    await writeFile(
      runFile,
      `${JSON.stringify(
        {
          id: runId,
          status: "running",
          programPath: "/tmp/program.ts",
          driver: "default",
          executor: "direct",
          createdAt: "2026-02-23T20:00:00.000Z",
          updatedAt: "2026-02-23T20:00:00.000Z",
          paths: {
            runDir,
            runFile,
            eventsFile,
            resultFile,
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(
      eventsFile,
      `${JSON.stringify({
        schemaVersion: 1,
        runId,
        sequence: 1,
        timestamp: "2026-02-23T20:00:00.000Z",
        type: "run:start",
        payload: {
          programPath: "/tmp/program.ts",
        },
      })}\n`,
      "utf-8",
    );

    try {
      const jsonStdout: Array<string> = [];
      const jsonStderr: Array<string> = [];

      const jsonCode = await runCli(
        ["wait", runId, "--timeout", "1", "--json", "--runs-dir", runsDirectory],
        {
          cwd: tempDirectory,
          homeDirectory: join(tempDirectory, "home"),
          pathExists: async () => false,
          io: {
            stdout: (line) => {
              jsonStdout.push(line);
            },
            stderr: (line) => {
              jsonStderr.push(line);
            },
          },
        },
      );

      expect(jsonCode).toBe(2);
      expect(jsonStderr).toHaveLength(0);
      const timeoutPayload = Schema.decodeUnknownSync(WaitTimeoutEnvelope)(jsonStdout[0]);
      expect(timeoutPayload.error.runId).toBe(runId);
      expect(timeoutPayload.error.timeoutSeconds).toBe(1);

      const humanStdout: Array<string> = [];
      const humanStderr: Array<string> = [];

      const humanCode = await runCli(
        ["wait", runId, "--timeout", "1", "--runs-dir", runsDirectory],
        {
          cwd: tempDirectory,
          homeDirectory: join(tempDirectory, "home"),
          pathExists: async () => false,
          io: {
            stdout: (line) => {
              humanStdout.push(line);
            },
            stderr: (line) => {
              humanStderr.push(line);
            },
          },
        },
      );

      expect(humanCode).toBe(2);
      expect(humanStdout).toHaveLength(0);
      expect(humanStderr[0]).toContain(`Timeout waiting for run ${runId}`);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
