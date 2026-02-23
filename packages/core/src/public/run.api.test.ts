import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { decodeMillEventJsonSync } from "../domain/event.schema";
import { runProgramSync, runWorker } from "./run.api";
import type { MillConfig } from "./types";

const makeConfig = (): MillConfig => ({
  defaultDriver: "default",
  defaultExecutor: "direct",
  defaultModel: "openai/gpt-5.3-codex",
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

      const parsedProgramResult = JSON.parse(output.result.programResult ?? "{}") as {
        readonly note?: string;
        readonly driver?: string;
        readonly executor?: string;
      };

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
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
