import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { decodeMillEventJsonSync, type MillEvent } from "../domain/event.schema";
import { decodeRunIdSync } from "../domain/run.schema";
import { runWithBunContext } from "../public/test-runtime.api";
import type { DriverRuntime } from "../public/types";
import { makeMillEngine } from "./engine.effect";
import { makeRunStore } from "./run-store.effect";

const testDriver: DriverRuntime = {
  name: "test-driver",
  spawn: (input) =>
    Effect.succeed({
      events: [
        {
          type: "milestone",
          message: `spawned:${input.agent}`,
        },
      ],
      result: {
        text: `driver:${input.prompt}`,
        sessionRef: `session/${input.agent}`,
        agent: input.agent,
        model: input.model,
        driver: "test-driver",
        exitCode: 0,
      },
    }),
};

const parseEvents = (content: string): ReadonlyArray<MillEvent> =>
  content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => decodeMillEventJsonSync(line));

const runTerminalTypes = new Set(["run:complete", "run:failed", "run:cancelled"]);
const spawnTerminalTypes = new Set(["spawn:complete", "spawn:error", "spawn:cancelled"]);

describe("MillEngine sync lifecycle", () => {
  it("persists deterministic run/start/spawn/complete lifecycle", async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), "mill-engine-"));
    const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);

    const engine = makeMillEngine({
      runsDirectory,
      defaultModel: "openai/gpt-5.3-codex",
      driverName: "default",
      driver: testDriver,
    });

    try {
      const output = await runWithBunContext(
        engine.runSync({
          runId,
          programPath: "/tmp/program.ts",
          executeProgram: (spawn) =>
            Effect.gen(function* () {
              const result = yield* spawn({
                agent: "scout",
                systemPrompt: "You are concise.",
                prompt: "Summarize this file.",
              });

              expect(result.sessionRef.length).toBeGreaterThan(0);
            }),
        }),
      );

      expect(output.result.status).toBe("complete");
      expect(output.result.spawns).toHaveLength(1);
      expect(output.run.status).toBe("complete");

      const status = await runWithBunContext(engine.status(runId));
      expect(status.status).toBe("complete");

      const eventsContent = await readFile(output.run.paths.eventsFile, "utf-8");
      const events = parseEvents(eventsContent);

      expect(events.length).toBeGreaterThan(0);

      const spawnComplete = events.find((event) => event.type === "spawn:complete");
      expect(spawnComplete).toBeDefined();

      if (spawnComplete !== undefined && spawnComplete.type === "spawn:complete") {
        expect(spawnComplete.payload.result.sessionRef.length).toBeGreaterThan(0);
      }

      for (const event of events) {
        expect(event.schemaVersion).toBe(1);
        expect(event.runId).toBe(runId);
        expect(event.sequence).toBeGreaterThan(0);
        expect(event.timestamp.length).toBeGreaterThan(0);
      }

      const runTerminalCount = events.filter((event) => runTerminalTypes.has(event.type)).length;
      expect(runTerminalCount).toBe(1);

      const spawnIds = events
        .filter((event): event is Extract<MillEvent, { type: "spawn:start" }> =>
          event.type === "spawn:start",
        )
        .map((event) => event.payload.spawnId);

      for (const spawnId of spawnIds) {
        const terminalCount = events.filter((event) => {
          if (!spawnTerminalTypes.has(event.type)) {
            return false;
          }

          if (event.type === "spawn:complete") {
            return event.payload.spawnId === spawnId;
          }

          if (event.type === "spawn:error") {
            return event.payload.spawnId === spawnId;
          }

          if (event.type === "spawn:cancelled") {
            return event.payload.spawnId === spawnId;
          }

          return false;
        }).length;

        expect(terminalCount).toBe(1);
      }
    } finally {
      await rm(runsDirectory, { recursive: true, force: true });
    }
  });

  it("wait resolves when terminal event arrives after wait subscription starts", async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), "mill-engine-wait-live-"));
    const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);

    const store = makeRunStore({ runsDirectory });
    const engine = makeMillEngine({
      runsDirectory,
      defaultModel: "openai/gpt-5.3-codex",
      driverName: "default",
      driver: testDriver,
    });

    try {
      await runWithBunContext(
        store.create({
          runId,
          programPath: "/tmp/program.ts",
          driver: "default",
          timestamp: "2026-02-23T20:00:00.000Z",
        }),
      );

      await runWithBunContext(
        store.appendEvent(runId, {
          schemaVersion: 1,
          runId,
          sequence: 1,
          timestamp: "2026-02-23T20:00:00.000Z",
          type: "run:start",
          payload: {
            programPath: "/tmp/program.ts",
          },
        }),
      );

      await runWithBunContext(
        store.appendEvent(runId, {
          schemaVersion: 1,
          runId,
          sequence: 2,
          timestamp: "2026-02-23T20:00:01.000Z",
          type: "run:status",
          payload: {
            status: "running",
          },
        }),
      );

      const appendTerminal = (async () => {
        await delay(50);

        await runWithBunContext(
          store.appendEvent(runId, {
            schemaVersion: 1,
            runId,
            sequence: 3,
            timestamp: "2026-02-23T20:00:02.000Z",
            type: "run:complete",
            payload: {
              result: {
                runId,
                status: "complete",
                startedAt: "2026-02-23T20:00:00.000Z",
                completedAt: "2026-02-23T20:00:02.000Z",
                spawns: [],
              },
            },
          }),
        );

        await runWithBunContext(
          store.setResult(
            runId,
            {
              runId,
              status: "complete",
              startedAt: "2026-02-23T20:00:00.000Z",
              completedAt: "2026-02-23T20:00:02.000Z",
              spawns: [],
            },
            "2026-02-23T20:00:02.000Z",
          ),
        );
      })();

      const waitedRun = await runWithBunContext(engine.wait(runId, "2 seconds"));

      expect(waitedRun.status).toBe("complete");
      await appendTerminal;
    } finally {
      await rm(runsDirectory, { recursive: true, force: true });
    }
  });

  it("wait fails with typed timeout error when no terminal event arrives", async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), "mill-engine-wait-timeout-"));
    const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);

    const store = makeRunStore({ runsDirectory });
    const engine = makeMillEngine({
      runsDirectory,
      defaultModel: "openai/gpt-5.3-codex",
      driverName: "default",
      driver: testDriver,
    });

    try {
      await runWithBunContext(
        store.create({
          runId,
          programPath: "/tmp/program.ts",
          driver: "default",
          timestamp: "2026-02-23T20:00:00.000Z",
        }),
      );

      await runWithBunContext(
        store.appendEvent(runId, {
          schemaVersion: 1,
          runId,
          sequence: 1,
          timestamp: "2026-02-23T20:00:00.000Z",
          type: "run:start",
          payload: {
            programPath: "/tmp/program.ts",
          },
        }),
      );

      const waitError = await runWithBunContext(Effect.flip(engine.wait(runId, 40)));

      expect(waitError).toMatchObject({
        _tag: "WaitTimeoutError",
        runId,
      });
    } finally {
      await rm(runsDirectory, { recursive: true, force: true });
    }
  });
});
