import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Command from "@effect/platform/Command";
import * as Schema from "@effect/schema/Schema";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime } from "effect";

const runtime = Runtime.defaultRuntime;

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

const StatusEnvelope = Schema.parseJson(
  Schema.Struct({
    id: Schema.String,
    status: Schema.String,
  }),
);

const commandOutput = (command: Command.Command): Promise<string> =>
  Runtime.runPromise(runtime)(Effect.provide(Command.string(command), BunContext.layer));

const commandExitCode = (command: Command.Command): Promise<number> =>
  Runtime.runPromise(runtime)(Effect.provide(Command.exitCode(command), BunContext.layer));

describe("mill --help --json (e2e)", () => {
  it("returns discovery contract payload on stdout", async () => {
    const output = await commandOutput(
      Command.make("bun", "run", "packages/cli/src/bin/mill.ts", "--help", "--json"),
    );

    const payload = Schema.decodeUnknownSync(DiscoveryEnvelope)(output);
    expect(payload.discoveryVersion).toBe(1);
    expect(payload.programApi.spawnRequired).toEqual(["agent", "systemPrompt", "prompt"]);
    expect(payload.drivers.default?.models).toEqual([
      "openai/gpt-5.3-codex",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(payload.authoring.instructions.length).toBeGreaterThan(0);
    expect(payload.async.submit).toBe("mill run <program.ts> --json");
  });
});

describe("mill run/status/wait (e2e)", () => {
  it("executes run --sync and wait --timeout returns terminal result", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-cli-e2e-"));
    const runsDirectory = join(tempDirectory, "runs");
    const programPath = join(tempDirectory, "program.ts");

    await writeFile(
      programPath,
      [
        "const first = await mill.spawn({",
        '  agent: "scout",',
        '  systemPrompt: "You are concise.",',
        '  prompt: "Inspect repository layout.",',
        "});",
        "const second = await mill.spawn({",
        '  agent: "synth",',
        '  systemPrompt: "You summarize findings.",',
        "  prompt: first.text,",
        "});",
        "globalThis.__millSecondText = second.text;",
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
      expect(runPayload.result.status).toBe("complete");
      expect(runPayload.result.spawns).toHaveLength(2);

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
  });

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
          driver: "default",
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
