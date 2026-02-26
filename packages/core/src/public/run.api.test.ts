import { spawn } from "node:child_process";
import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "@effect/schema/Schema";
import { Effect } from "effect";
import { decodeMillEventJsonSync } from "../domain/event.schema";
import { decodeRunIdSync } from "../domain/run.schema";
import { makeRunStore } from "../internal/run-store.effect";
import { runWithBunContext } from "./test-runtime.api";
import { cancelRun, runProgramSync, runWorker, submitRun } from "./run.api";
import type { MillConfig } from "./types";

const ProgramResultEnvelope = Schema.parseJson(
  Schema.Struct({
    note: Schema.optional(Schema.String),
    driver: Schema.optional(Schema.String),
    executor: Schema.optional(Schema.String),
  }),
);

const sleep = (millis: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, millis);
  });

const waitForProcessExit = async (pid: number, timeoutMillis: number): Promise<void> => {
  const deadline = Date.now() + timeoutMillis;

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }

    await sleep(25);
  }

  throw new Error(`child process ${pid} did not exit in time`);
};

const makeConfig = (): MillConfig => ({
  defaultDriver: "default",
  defaultExecutor: "direct",
  defaultModel: "openai/gpt-5.3-codex",
  maxRunDepth: 1,
  drivers: {
    default: {
      description: "default driver",
      modelFormat: "provider/model-id",
      process: {
        command: "default",
        args: [],
        env: {},
      },
      codec: {
        modelCatalog: Effect.succeed(["default/model"]),
      },
      runtime: {
        name: "default",
        spawn: (input) =>
          Effect.succeed({
            events: [
              {
                type: "milestone",
                message: `default:${input.agent}`,
              },
            ],
            result: {
              text: `default:${input.prompt}`,
              sessionRef: `session/default/${input.agent}`,
              agent: input.agent,
              model: input.model,
              driver: "default",
              exitCode: 0,
            },
          }),
      },
    },
    codex: {
      description: "codex driver",
      modelFormat: "provider/model-id",
      process: {
        command: "codex",
        args: [],
        env: {},
      },
      codec: {
        modelCatalog: Effect.succeed(["openai/gpt-5.3-codex"]),
      },
      runtime: {
        name: "codex",
        spawn: (input) =>
          Effect.succeed({
            events: [
              {
                type: "milestone",
                message: `codex:${input.agent}`,
              },
            ],
            result: {
              text: `codex:${input.prompt}`,
              sessionRef: `session/codex/${input.agent}`,
              agent: input.agent,
              model: input.model,
              driver: "codex",
              exitCode: 0,
            },
          }),
      },
    },
  },
  executors: {
    direct: {
      description: "direct executor",
      runtime: {
        name: "direct",
        runProgram: (input) =>
          Effect.zipRight(
            Effect.sync(() => {
              (globalThis as { __millExecutorName?: string }).__millExecutorName = "direct";
            }),
            input.execute,
          ),
      },
    },
    vm: {
      description: "vm executor",
      runtime: {
        name: "vm",
        runProgram: (input) =>
          Effect.zipRight(
            Effect.sync(() => {
              (globalThis as { __millExecutorName?: string }).__millExecutorName = "vm";
            }),
            input.execute,
          ),
      },
    },
  },
  extensions: [
    {
      name: "tools",
      setup: () => Effect.fail("setup exploded"),
      onEvent: (event) =>
        event.type === "spawn:start" ? Effect.fail("event exploded") : Effect.void,
      api: {
        echo: (...args) => Effect.succeed(`echo:${String(args[0] ?? "")}`),
      },
    },
  ],
  authoring: {
    instructions: "use spawn + extension APIs",
  },
});

describe("run.api integration", () => {
  it("selects driver/executor overrides, injects extension API, and emits extension:error events", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-run-api-"));
    const homeDirectory = join(tempDirectory, "home");
    const programPath = join(tempDirectory, "program.ts");

    await writeFile(
      programPath,
      [
        'const note = await mill.tools.echo("hello");',
        "const spawned = await mill.spawn({",
        '  agent: "scout",',
        '  systemPrompt: "You are concise.",',
        "  prompt: note,",
        "});",
        'return JSON.stringify({ note, driver: spawned.driver, executor: globalThis.__millExecutorName ?? "unknown" });',
      ].join("\n"),
      "utf-8",
    );

    const defaults = makeConfig();

    try {
      const output = await runProgramSync({
        defaults,
        programPath,
        cwd: tempDirectory,
        homeDirectory,
        pathExists: async () => false,
        driverName: "codex",
        executorName: "vm",
        launchWorker: async (launchInput) => {
          await runWorker({
            defaults,
            runId: launchInput.runId,
            programPath: launchInput.programPath,
            cwd: launchInput.cwd,
            homeDirectory,
            runsDirectory: launchInput.runsDirectory,
            driverName: launchInput.driverName,
            executorName: launchInput.executorName,
            pathExists: async () => false,
          });
        },
      });

      expect(output.run.status).toBe("complete");
      expect(output.run.driver).toBe("codex");
      expect(output.run.executor).toBe("vm");
      expect(output.result.spawns[0]?.driver).toBe("codex");

      const parsedProgramResult = Schema.decodeUnknownSync(ProgramResultEnvelope)(
        output.result.programResult ?? "{}",
      );

      expect(parsedProgramResult.note).toBe("echo:hello");
      expect(parsedProgramResult.driver).toBe("codex");
      expect(parsedProgramResult.executor).toBe("vm");

      const eventsContent = await readFile(output.run.paths.eventsFile, "utf-8");
      const eventTypes = eventsContent
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => decodeMillEventJsonSync(line).type);

      expect(eventTypes.includes("extension:error")).toBe(true);

      const hostMarker = await readFile(
        join(output.run.paths.runDir, "program-host.marker"),
        "utf-8",
      );
      expect(hostMarker).toContain("process-host:bun");
      expect(hostMarker).toContain(`executor=${output.run.executor}`);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("enforces maxRunDepth recursion guard on nested run submissions", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-run-depth-"));
    const homeDirectory = join(tempDirectory, "home");
    const programPath = join(tempDirectory, "program.ts");
    const previousDepth = process.env.MILL_RUN_DEPTH;

    await writeFile(programPath, "return 'ok';\n", "utf-8");

    try {
      process.env.MILL_RUN_DEPTH = "1";

      await expect(
        submitRun({
          defaults: makeConfig(),
          programPath,
          cwd: tempDirectory,
          homeDirectory,
          pathExists: async () => false,
          launchWorker: async () => {
            throw new Error("launchWorker should not be called when depth guard blocks run");
          },
        }),
      ).rejects.toThrow("maxRunDepth=1");

      let launchCalled = false;

      const submitted = await submitRun({
        defaults: {
          ...makeConfig(),
          maxRunDepth: 2,
        },
        programPath,
        cwd: tempDirectory,
        homeDirectory,
        pathExists: async () => false,
        launchWorker: async () => {
          launchCalled = true;
        },
      });

      expect(submitted.status).toBe("pending");
      expect(launchCalled).toBe(true);
    } finally {
      if (previousDepth === undefined) {
        delete process.env.MILL_RUN_DEPTH;
      } else {
        process.env.MILL_RUN_DEPTH = previousDepth;
      }

      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("cancelRun kills detached worker processes using persisted worker.pid", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-run-cancel-"));
    const runsDirectory = join(tempDirectory, "runs");
    const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);
    const defaults = makeConfig();

    const store = makeRunStore({ runsDirectory });

    const worker = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "_worker", "--run-id", runId],
      {
        stdio: "ignore",
      },
    );

    if (worker.pid === undefined) {
      throw new Error("failed to start synthetic worker process");
    }

    try {
      await runWithBunContext(
        store.create({
          runId,
          programPath: "/tmp/program.ts",
          driver: "default",
          executor: "direct",
          status: "running",
          timestamp: "2026-02-25T10:00:00.000Z",
        }),
      );

      const runDirectory = join(runsDirectory, runId);
      await writeFile(join(runDirectory, "worker.pid"), `${worker.pid}\n`, "utf-8");

      const cancelled = await cancelRun({
        defaults,
        runId,
        runsDirectory,
        cwd: tempDirectory,
        pathExists: async () => false,
      });

      expect(cancelled.status).toBe("cancelled");

      await waitForProcessExit(worker.pid, 2000);

      const cancelLog = await readFile(join(runDirectory, "logs", "cancel.log"), "utf-8");
      expect(cancelLog).toContain("cancel:kill term-sent");
    } finally {
      try {
        worker.kill("SIGKILL");
      } catch {
        // already exited
      }
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
