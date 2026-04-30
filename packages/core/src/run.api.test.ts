import { spawn } from "node:child_process";
import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { Effect } from "effect";
import { decodeMillEventJsonSync } from "./event.schema";
import { decodeRunIdSync } from "./run.schema";
import { makeRunStore } from "./run-store.effect";
import { runWithBunServices } from "./test-runtime";
import { ProcessControlError, cancelRun, runProgramSync, runWorker, submitRun } from "./run.api";
import { createMillRuntime } from "./runtime.api";
import type { AgentRuntime, ExtensionRegistration } from "./types";

const ProgramResultEnvelope = Schema.fromJsonString(
  Schema.Struct({
    note: Schema.optional(Schema.String),
    driver: Schema.optional(Schema.String),
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

const makeAgentRuntime = (name: string): AgentRuntime => ({
  name,
  createSession: (input) =>
    Effect.succeed({
      sessionRef: `session/${name}/${input.role}`,
      startTurn: (turn) =>
        Effect.succeed({
          events: [
            {
              type: "milestone",
              message: `${name}:${input.role}`,
            },
          ],
          result: {
            text: `${name}:${turn.prompt}`,
            sessionRef: `session/${name}/${input.role}`,
            role: input.role,
            model: input.model,
            driver: name,
            exitCode: 0,
          },
        }),
      cancelTurn: () => Effect.void,
      close: () => Effect.void,
    }),
});

const extensions: ReadonlyArray<ExtensionRegistration> = [
  {
    name: "tools",
    setup: () => Effect.fail("setup exploded"),
    onEvent: (event) => (event.type === "task:start" ? Effect.fail("event exploded") : Effect.void),
    api: {
      echo: (...args) => Effect.succeed(`echo:${String(args[0] ?? "")}`),
    },
  },
];

const makeRunOptions = () => ({
  agentRuntimes: {
    default: makeAgentRuntime("default"),
    codex: makeAgentRuntime("codex"),
  },
  extensions,
  maxRunDepth: 1,
});

describe("run.api integration", () => {
  it("runs sync programs through the mill runtime actor facade", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-runtime-api-"));
    const homeDirectory = join(tempDirectory, "home");
    const programPath = join(tempDirectory, "program.ts");
    const runOptions = makeRunOptions();

    await writeFile(
      programPath,
      [
        'import { task as millTask, codex } from "@mill/core/program";',
        "const task = millTask({",
        '  agent: codex("openai/gpt-5.3-codex"),',
        '  prompt: "from runtime",',
        '  role: "scout",',
        "}).start();",
        "const taskResult = await task.done;",
        "export const result = taskResult.text;",
      ].join("\n"),
      "utf-8",
    );

    try {
      const runtime = createMillRuntime({
        ...runOptions,
        cwd: tempDirectory,
        homeDirectory,
        launchWorker: async (launchInput) => {
          await runWorker({
            ...runOptions,
            runId: launchInput.runId,
            programPath: launchInput.programPath,
            cwd: launchInput.cwd,
            homeDirectory,
            runsDirectory: launchInput.runsDirectory,
          });
        },
      });
      const run = runtime.run({ programPath, sync: true }).start();
      const output = await run.done;

      expect("run" in output).toBe(true);
      expect(run.getSnapshot()?.status).toBe("complete");

      if ("run" in output) {
        expect(output.result.programResult).toBe("codex:from runtime");
      }
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("uses task agent providers, injects extension API, and emits extension:error events", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-run-api-"));
    const homeDirectory = join(tempDirectory, "home");
    const programPath = join(tempDirectory, "program.ts");
    const previousDepth = process.env.MILL_RUN_DEPTH;

    delete process.env.MILL_RUN_DEPTH;

    await writeFile(
      programPath,
      [
        'import { mill, codex } from "@mill/core/program";',
        'const note = await mill.tools.echo("hello");',
        "const task = mill.task({",
        '  agent: codex("openai/gpt-5.3-codex"),',
        '  system: "You are concise.",',
        "  prompt: note,",
        '  role: "scout",',
        "}).start();",
        "const taskResult = await task.done;",
        "export const result = JSON.stringify({ note, driver: taskResult.driver });",
      ].join("\n"),
      "utf-8",
    );

    const runOptions = makeRunOptions();

    try {
      const output = await runProgramSync({
        ...runOptions,
        programPath,
        cwd: tempDirectory,
        homeDirectory,
        launchWorker: async (launchInput) => {
          await runWorker({
            ...runOptions,
            runId: launchInput.runId,
            programPath: launchInput.programPath,
            cwd: launchInput.cwd,
            homeDirectory,
            runsDirectory: launchInput.runsDirectory,
          });
        },
      });

      expect(output.run.status).toBe("complete");
      expect(output.result.tasks[0]?.driver).toBe("codex");

      const parsedProgramResult = Schema.decodeUnknownSync(ProgramResultEnvelope)(
        output.result.programResult ?? "{}",
      );

      expect(parsedProgramResult.note).toBe("echo:hello");
      expect(parsedProgramResult.driver).toBe("codex");

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
      expect(hostMarker).toContain("program-host:import");
    } finally {
      if (previousDepth === undefined) {
        delete process.env.MILL_RUN_DEPTH;
      } else {
        process.env.MILL_RUN_DEPTH = previousDepth;
      }

      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("provides imported actor-shaped task API to program host", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-run-task-api-"));
    const homeDirectory = join(tempDirectory, "home");
    const programPath = join(tempDirectory, "program.ts");

    await writeFile(
      programPath,
      [
        'import { task as millTask, codex } from "@mill/core/program";',
        "const statuses = [];",
        "const task = millTask({",
        '  agent: codex("openai/gpt-5.3-codex"),',
        '  prompt: "Say hello from task",',
        "});",
        "task.subscribe((snapshot) => statuses.push(snapshot.status));",
        "const taskResult = await task.start().done;",
        "export const result = JSON.stringify({",
        "  text: taskResult.text,",
        "  driver: taskResult.driver,",
        "  status: task.getSnapshot().status,",
        "  statuses,",
        "});",
      ].join("\n"),
      "utf-8",
    );

    try {
      const output = await runProgramSync({
        ...makeRunOptions(),
        programPath,
        cwd: tempDirectory,
        homeDirectory,
        launchWorker: async (launchInput) => {
          await runWorker({
            ...makeRunOptions(),
            runId: launchInput.runId,
            programPath: launchInput.programPath,
            cwd: launchInput.cwd,
            homeDirectory,
            runsDirectory: launchInput.runsDirectory,
          });
        },
      });

      expect(output.run.status).toBe("complete");
      expect(output.result.tasks).toHaveLength(1);
      expect(output.result.tasks[0]?.driver).toBe("codex");

      const parsed = JSON.parse(String(output.result.programResult ?? "{}")) as {
        readonly text?: string;
        readonly driver?: string;
        readonly status?: string;
        readonly statuses?: ReadonlyArray<string>;
      };

      expect(parsed).toEqual({
        text: "codex:Say hello from task",
        driver: "codex",
        status: "complete",
        statuses: ["idle", "running", "complete"],
      });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("defaults runs directory to explicit env HOME/.mill/runs when homeDirectory is omitted", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-run-home-default-"));
    const homeDirectory = join(tempDirectory, "home");
    const programPath = join(tempDirectory, "program.ts");

    await writeFile(programPath, "export const result = 'home-default-ok';\n", "utf-8");

    let capturedRunsDirectory: string | undefined;

    try {
      const output = await runProgramSync({
        ...makeRunOptions(),
        programPath,
        cwd: tempDirectory,
        env: { HOME: homeDirectory },
        launchWorker: async (launchInput) => {
          capturedRunsDirectory = launchInput.runsDirectory;
          await runWorker({
            ...makeRunOptions(),
            runId: launchInput.runId,
            programPath: launchInput.programPath,
            cwd: launchInput.cwd,
            runsDirectory: launchInput.runsDirectory,
          });
        },
      });

      const expectedRunsDirectory = join(homeDirectory, ".mill", "runs");

      expect(capturedRunsDirectory).toBe(expectedRunsDirectory);
      expect(output.run.paths.runDir.startsWith(expectedRunsDirectory)).toBe(true);
      expect(output.run.status).toBe("complete");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("enforces maxRunDepth recursion guard on nested run submissions", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-run-depth-"));
    const homeDirectory = join(tempDirectory, "home");
    const programPath = join(tempDirectory, "program.ts");

    await writeFile(programPath, "export const result = 'ok';\n", "utf-8");

    try {
      await expect(
        submitRun({
          ...makeRunOptions(),
          programPath,
          cwd: tempDirectory,
          homeDirectory,
          env: { MILL_RUN_DEPTH: "1" },
          launchWorker: async () => {
            throw new Error("launchWorker should not be called when depth guard blocks run");
          },
        }),
      ).rejects.toThrow("maxRunDepth=1");

      let launchCalled = false;

      const submitted = await submitRun({
        ...makeRunOptions(),
        maxRunDepth: 2,
        programPath,
        cwd: tempDirectory,
        homeDirectory,
        env: { MILL_RUN_DEPTH: "1" },
        launchWorker: async () => {
          launchCalled = true;
        },
      });

      expect(submitted.status).toBe("pending");
      expect(launchCalled).toBe(true);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("cancelRun kills detached worker processes using persisted worker.pid", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-run-cancel-"));
    const runsDirectory = join(tempDirectory, "runs");
    const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);
    const runOptions = makeRunOptions();

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
      await runWithBunServices(
        store.create({
          runId,
          programPath: "/tmp/program.ts",
          status: "running",
          timestamp: "2026-02-25T10:00:00.000Z",
        }),
      );

      const runDirectory = join(runsDirectory, runId);
      await writeFile(join(runDirectory, "worker.pid"), `${worker.pid}\n`, "utf-8");

      const cancelled = await cancelRun({
        ...runOptions,
        runId,
        runsDirectory,
        cwd: tempDirectory,
        processControl: {
          isAlive: (pid) =>
            Effect.try({
              try: () => process.kill(pid, 0),
              catch: (cause) => new ProcessControlError({ operation: "isAlive", pid, cause }),
            }).pipe(Effect.as(true)),
          sendSignal: (pid, signal) =>
            Effect.try({
              try: () => process.kill(pid, signal),
              catch: (cause) =>
                new ProcessControlError({ operation: "sendSignal", pid, signal, cause }),
            }).pipe(Effect.as(true)),
        },
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
