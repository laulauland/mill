import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Command from "@effect/platform/Command";
import * as Schema from "@effect/schema/Schema";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime } from "effect";

const runtime = Runtime.defaultRuntime;

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
  }),
);

const CancelEnvelope = Schema.parseJson(
  Schema.Struct({
    runId: Schema.String,
    status: Schema.String,
    alreadyTerminal: Schema.Boolean,
  }),
);

const WatchOutputEnvelope = Schema.parseJson(
  Schema.Union(
    Schema.Struct({
      kind: Schema.Literal("event"),
      runId: Schema.String,
      event: Schema.Struct({
        type: Schema.String,
        runId: Schema.String,
      }),
    }),
    Schema.Struct({
      kind: Schema.Literal("io"),
      runId: Schema.String,
      source: Schema.Union(Schema.Literal("driver"), Schema.Literal("program")),
      stream: Schema.Union(Schema.Literal("stdout"), Schema.Literal("stderr")),
      line: Schema.String,
      timestamp: Schema.String,
      spawnId: Schema.optional(Schema.String),
    }),
  ),
);

const ListEnvelope = Schema.parseJson(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
    }),
  ),
);

const EventTypeEnvelope = Schema.parseJson(
  Schema.Struct({
    type: Schema.String,
  }),
);

const commandOutput = (command: Command.Command): Promise<string> =>
  Runtime.runPromise(runtime)(Effect.provide(Command.string(command), BunContext.layer));

const commandExitCode = (command: Command.Command): Promise<number> =>
  Runtime.runPromise(runtime)(Effect.provide(Command.exitCode(command), BunContext.layer));

describe("mill help (e2e)", () => {
  it("does not expose discovery subcommand", async () => {
    const exitCode = await commandExitCode(
      Command.make("bun", "run", "packages/cli/src/bin/mill.ts", "discovery", "--json"),
    );

    expect(exitCode).toBe(1);
  });

  it("prints top-level help via built-in --help", async () => {
    const output = await commandOutput(
      Command.make("bun", "run", "packages/cli/src/bin/mill.ts", "--help"),
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
      Command.make("bun", "run", "packages/cli/src/bin/mill.ts", "run", "--help"),
    );

    expect(output).toContain("$ run [--json] [--sync]");
    expect(output).toContain("--driver");
    expect(output).toContain("--executor");
  });
});

describe("mill run/status/wait (e2e)", () => {
  it("supports run --driver and --executor selection", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-cli-select-e2e-"));
    const runsDirectory = join(tempDirectory, "runs");
    const programPath = join(tempDirectory, "program.ts");

    await writeFile(
      programPath,
      [
        "await new Promise((resolve) => setTimeout(resolve, 50));",
        "return 'driver-executor-selected';",
      ].join("\n"),
      "utf-8",
    );

    try {
      const runOutput = await commandOutput(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "run",
          programPath,
          "--sync",
          "--json",
          "--driver",
          "pi",
          "--executor",
          "direct",
          "--runs-dir",
          runsDirectory,
        ),
      );

      const runPayload = Schema.decodeUnknownSync(RunSyncEnvelope)(runOutput);
      expect(runPayload.run.driver).toBe("pi");
      expect(runPayload.run.executor).toBe("direct");
      expect(runPayload.result.spawns).toHaveLength(0);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("submits async run by default, then status/wait observes completion", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-cli-async-e2e-"));
    const runsDirectory = join(tempDirectory, "runs");
    const programPath = join(tempDirectory, "program.ts");

    await writeFile(
      programPath,
      [
        "await new Promise((resolve) => setTimeout(resolve, 150));",
        "globalThis.__millAsyncProgramText = 'async-complete';",
      ].join("\n"),
      "utf-8",
    );

    try {
      const submitOutput = await commandOutput(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "run",
          programPath,
          "--json",
          "--runs-dir",
          runsDirectory,
        ),
      );

      const submitPayload = Schema.decodeUnknownSync(RunSubmitEnvelope)(submitOutput);
      expect(submitPayload.runId.length).toBeGreaterThan(0);

      const statusOutput = await commandOutput(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "status",
          submitPayload.runId,
          "--json",
          "--runs-dir",
          runsDirectory,
        ),
      );

      const statusPayload = Schema.decodeUnknownSync(StatusEnvelope)(statusOutput);
      expect(statusPayload.id).toBe(submitPayload.runId);

      const waitOutput = await commandOutput(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "wait",
          submitPayload.runId,
          "--timeout",
          "5",
          "--json",
          "--runs-dir",
          runsDirectory,
        ),
      );

      const waitPayload = Schema.decodeUnknownSync(StatusEnvelope)(waitOutput);
      expect(waitPayload.id).toBe(submitPayload.runId);
      expect(waitPayload.status).toBe("complete");

      const copiedProgram = await readFile(join(submitPayload.paths.runDir, "program.ts"), "utf-8");
      const workerLog = await readFile(
        join(submitPayload.paths.runDir, "logs", "worker.log"),
        "utf-8",
      );

      expect(copiedProgram).toContain("setTimeout");
      expect(workerLog.length).toBeGreaterThan(0);

      const workerExitCode = await commandExitCode(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "_worker",
          "--run-id",
          submitPayload.runId,
          "--program",
          join(submitPayload.paths.runDir, "program.ts"),
          "--runs-dir",
          runsDirectory,
        ),
      );

      expect(workerExitCode).toBe(0);

      const eventsFile = await readFile(submitPayload.paths.eventsFile, "utf-8");
      const terminalEventCount = eventsFile
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => Schema.decodeUnknownSync(EventTypeEnvelope)(line))
        .filter(
          (event) =>
            event.type === "run:complete" ||
            event.type === "run:failed" ||
            event.type === "run:cancelled",
        ).length;

      expect(terminalEventCount).toBe(1);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("executes run --sync and wait --timeout returns terminal result", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-cli-e2e-"));
    const runsDirectory = join(tempDirectory, "runs");
    const programPath = join(tempDirectory, "program.ts");

    await writeFile(
      programPath,
      [
        "await new Promise((resolve) => setTimeout(resolve, 80));",
        "await new Promise((resolve) => setTimeout(resolve, 80));",
        "globalThis.__millSecondText = 'sync-complete';",
      ].join("\n"),
      "utf-8",
    );

    try {
      const runOutput = await commandOutput(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "run",
          programPath,
          "--sync",
          "--json",
          "--runs-dir",
          runsDirectory,
        ),
      );

      const runPayload = Schema.decodeUnknownSync(RunSyncEnvelope)(runOutput);
      expect(runPayload.run.status).toBe("complete");
      expect(runPayload.run.driver).toBe("pi");
      expect(runPayload.run.executor).toBe("direct");
      expect(runPayload.result.status).toBe("complete");
      expect(runPayload.result.spawns).toHaveLength(0);

      const statusOutput = await commandOutput(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "status",
          runPayload.run.id,
          "--json",
          "--runs-dir",
          runsDirectory,
        ),
      );

      const statusPayload = Schema.decodeUnknownSync(StatusEnvelope)(statusOutput);
      expect(statusPayload.id).toBe(runPayload.run.id);
      expect(statusPayload.status).toBe("complete");

      const waitOutput = await commandOutput(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "wait",
          runPayload.run.id,
          "--timeout",
          "2",
          "--json",
          "--runs-dir",
          runsDirectory,
        ),
      );

      const waitPayload = Schema.decodeUnknownSync(StatusEnvelope)(waitOutput);
      expect(waitPayload.id).toBe(runPayload.run.id);
      expect(waitPayload.status).toBe("complete");

      const runFile = await readFile(runPayload.run.paths.runFile, "utf-8");
      const eventsFile = await readFile(runPayload.run.paths.eventsFile, "utf-8");
      const resultFile = await readFile(runPayload.run.paths.resultFile, "utf-8");

      expect(runFile.length).toBeGreaterThan(0);
      expect(eventsFile.length).toBeGreaterThan(0);
      expect(resultFile.length).toBeGreaterThan(0);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("runs cancel/watch/list matrix across concurrent runs", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-cli-matrix-e2e-"));
    const runsDirectory = join(tempDirectory, "runs");
    const completeProgramPath = join(tempDirectory, "complete.ts");
    const cancelProgramPath = join(tempDirectory, "cancel.ts");

    await writeFile(
      completeProgramPath,
      [
        "await new Promise((resolve) => setTimeout(resolve, 150));",
        "return 'quick-complete';",
      ].join("\n"),
      "utf-8",
    );

    await writeFile(
      cancelProgramPath,
      [
        "await new Promise((resolve) => setTimeout(resolve, 3000));",
        "return 'late-complete';",
      ].join("\n"),
      "utf-8",
    );

    try {
      const submitCompleteOutput = await commandOutput(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "run",
          completeProgramPath,
          "--json",
          "--runs-dir",
          runsDirectory,
        ),
      );

      const submitCancelOutput = await commandOutput(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "run",
          cancelProgramPath,
          "--json",
          "--runs-dir",
          runsDirectory,
        ),
      );

      const completeRun = Schema.decodeUnknownSync(RunSubmitEnvelope)(submitCompleteOutput);
      const cancelRun = Schema.decodeUnknownSync(RunSubmitEnvelope)(submitCancelOutput);

      const cancelOutput = await commandOutput(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "cancel",
          cancelRun.runId,
          "--json",
          "--runs-dir",
          runsDirectory,
        ),
      );

      const cancelPayload = Schema.decodeUnknownSync(CancelEnvelope)(cancelOutput);
      expect(cancelPayload.runId).toBe(cancelRun.runId);
      expect(cancelPayload.status).toBe("cancelled");

      const waitCancelledOutput = await commandOutput(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "wait",
          cancelRun.runId,
          "--timeout",
          "8",
          "--json",
          "--runs-dir",
          runsDirectory,
        ),
      );

      const waitCancelled = Schema.decodeUnknownSync(StatusEnvelope)(waitCancelledOutput);
      expect(waitCancelled.status).toBe("cancelled");

      const waitCompleteOutput = await commandOutput(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "wait",
          completeRun.runId,
          "--timeout",
          "8",
          "--json",
          "--runs-dir",
          runsDirectory,
        ),
      );

      const waitComplete = Schema.decodeUnknownSync(StatusEnvelope)(waitCompleteOutput);
      expect(waitComplete.status).toBe("complete");

      const watchOutput = await commandOutput(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "watch",
          "--run",
          completeRun.runId,
          "--channel",
          "all",
          "--json",
          "--runs-dir",
          runsDirectory,
        ),
      );

      const watchLines = watchOutput
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => Schema.decodeUnknownSync(WatchOutputEnvelope)(line));

      expect(watchLines.length).toBeGreaterThan(0);
      const watchTerminalCount = watchLines.filter(
        (entry) =>
          entry.kind === "event" &&
          (entry.event.type === "run:complete" ||
            entry.event.type === "run:failed" ||
            entry.event.type === "run:cancelled"),
      ).length;
      expect(watchTerminalCount).toBe(1);

      const watchCancelledOutput = await commandOutput(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "watch",
          "--run",
          cancelRun.runId,
          "--channel",
          "events",
          "--json",
          "--runs-dir",
          runsDirectory,
        ),
      );

      const cancelledLines = watchCancelledOutput
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => Schema.decodeUnknownSync(WatchOutputEnvelope)(line));

      expect(
        cancelledLines.some(
          (entry) => entry.kind === "event" && entry.event.type === "run:cancelled",
        ),
      ).toBe(true);

      const listOutput = await commandOutput(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "ls",
          "--json",
          "--runs-dir",
          runsDirectory,
        ),
      );

      const listedRuns = Schema.decodeUnknownSync(ListEnvelope)(listOutput);
      const cancelledListed = listedRuns.find((item) => item.id === cancelRun.runId);
      const completeListed = listedRuns.find((item) => item.id === completeRun.runId);

      expect(cancelledListed?.status).toBe("cancelled");
      expect(completeListed?.status).toBe("complete");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("wait timeout exits non-zero", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-cli-wait-timeout-e2e-"));
    const runsDirectory = join(tempDirectory, "runs");
    const runId = `run_timeout_e2e_${crypto.randomUUID()}`;
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
          driver: "pi",
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
      const exitCode = await commandExitCode(
        Command.make(
          "bun",
          "run",
          "packages/cli/src/bin/mill.ts",
          "wait",
          runId,
          "--timeout",
          "1",
          "--json",
          "--runs-dir",
          runsDirectory,
        ),
      );

      expect(exitCode).toBe(2);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
