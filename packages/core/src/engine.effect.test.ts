import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Effect, Stream } from "effect";
import { decodeMillEventJsonSync, type MillEvent } from "./event.schema";
import { decodeRunIdSync } from "./run.schema";
import { runWithBunServices } from "./test-runtime";
import type { AgentRuntime } from "./types";
import { makeMillEngine } from "./engine.effect";
import { makeRunStore } from "./run-store.effect";
import { codex } from "./task.api";

const testRuntime: AgentRuntime = {
  name: "test-provider",
  createSession: (input) =>
    Effect.succeed({
      sessionRef: `session/${input.role}`,
      startTurn: (turn) =>
        Effect.succeed({
          events: [
            {
              type: "milestone",
              message: `started:${input.role}`,
            },
          ],
          result: {
            text: `agent:${turn.prompt}`,
            sessionRef: `session/${input.role}`,
            role: input.role,
            model: input.model,
            provider: "test-provider",
            exitCode: 0,
          },
        }),
      cancelTurn: () => Effect.void,
      close: () => Effect.void,
    }),
};

const parseEvents = (content: string): ReadonlyArray<MillEvent> =>
  content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => decodeMillEventJsonSync(line));

const runTerminalTypes = new Set(["run:complete", "run:failed", "run:cancelled"]);
const taskTerminalTypes = new Set(["task:complete", "task:error", "task:cancelled"]);

describe("MillEngine sync lifecycle", () => {
  it("submits pending runs before worker execution", async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), "mill-engine-submit-"));
    const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);

    const engine = makeMillEngine({
      runsDirectory,
      agentRuntimes: { default: testRuntime, codex: testRuntime },
      extensions: [],
    });

    try {
      const submitted = await runWithBunServices(
        engine.submit({
          runId,
          programPath: "/tmp/program.ts",
        }),
      );

      expect(submitted.id).toBe(runId);
      expect(submitted.status).toBe("pending");
    } finally {
      await rm(runsDirectory, { recursive: true, force: true });
    }
  });

  it("persists deterministic run/start/task/complete lifecycle", async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), "mill-engine-"));
    const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);

    const engine = makeMillEngine({
      runsDirectory,
      agentRuntimes: { default: testRuntime, codex: testRuntime },
      extensions: [],
    });

    try {
      const output = await runWithBunServices(
        engine.runSync({
          runId,
          programPath: "/tmp/program.ts",
          executeProgram: (task) =>
            Effect.gen(function* () {
              const result = yield* task({
                agent: codex("openai/gpt-5.3-codex"),
                system: "You are concise.",
                prompt: "Summarize this file.",
                role: "scout",
              });

              expect(result.sessionRef.length).toBeGreaterThan(0);
            }),
        }),
      );

      expect(output.result.status).toBe("complete");
      expect(output.result.tasks).toHaveLength(1);
      expect(output.run.status).toBe("complete");

      const status = await runWithBunServices(engine.status(runId));
      expect(status.status).toBe("complete");

      const eventsContent = await readFile(output.run.paths.eventsFile, "utf-8");
      const events = parseEvents(eventsContent);

      expect(events.length).toBeGreaterThan(0);

      const taskComplete = events.find((event) => event.type === "task:complete");
      expect(taskComplete).toBeDefined();

      if (taskComplete !== undefined && taskComplete.type === "task:complete") {
        expect(taskComplete.payload.result.sessionRef.length).toBeGreaterThan(0);
      }

      for (const event of events) {
        expect(event.schemaVersion).toBe(1);
        expect(event.runId).toBe(runId);
        expect(event.sequence).toBeGreaterThan(0);
        expect(event.timestamp.length).toBeGreaterThan(0);
      }

      const runTerminalCount = events.filter((event) => runTerminalTypes.has(event.type)).length;
      expect(runTerminalCount).toBe(1);

      const taskIds = events
        .filter(
          (event): event is Extract<MillEvent, { type: "task:start" }> =>
            event.type === "task:start",
        )
        .map((event) => event.payload.taskId);

      for (const taskId of taskIds) {
        const terminalCount = events.filter((event) => {
          if (!taskTerminalTypes.has(event.type)) {
            return false;
          }

          if (event.type === "task:complete") {
            return event.payload.taskId === taskId;
          }

          if (event.type === "task:error") {
            return event.payload.taskId === taskId;
          }

          if (event.type === "task:cancelled") {
            return event.payload.taskId === taskId;
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
      agentRuntimes: { default: testRuntime, codex: testRuntime },
      extensions: [],
    });

    try {
      await runWithBunServices(
        store.create({
          runId,
          programPath: "/tmp/program.ts",
          timestamp: "2026-02-23T20:00:00.000Z",
        }),
      );

      await runWithBunServices(
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

      await runWithBunServices(
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

        await runWithBunServices(
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
                tasks: [],
              },
            },
          }),
        );

        await runWithBunServices(
          store.setResult(
            runId,
            {
              runId,
              status: "complete",
              startedAt: "2026-02-23T20:00:00.000Z",
              completedAt: "2026-02-23T20:00:02.000Z",
              tasks: [],
            },
            "2026-02-23T20:00:02.000Z",
          ),
        );
      })();

      const waitedRun = await runWithBunServices(engine.wait(runId, "2 seconds"));

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
      agentRuntimes: { default: testRuntime, codex: testRuntime },
      extensions: [],
    });

    try {
      await runWithBunServices(
        store.create({
          runId,
          programPath: "/tmp/program.ts",
          timestamp: "2026-02-23T20:00:00.000Z",
        }),
      );

      await runWithBunServices(
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

      const waitError = await runWithBunServices(Effect.flip(engine.wait(runId, 40)));

      expect(waitError).toMatchObject({
        _tag: "WaitTimeoutError",
        runId,
      });
    } finally {
      await rm(runsDirectory, { recursive: true, force: true });
    }
  });

  it("inspect returns decoded persisted run and task views", async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), "mill-engine-inspect-"));
    const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);

    const engine = makeMillEngine({
      runsDirectory,
      agentRuntimes: { default: testRuntime, codex: testRuntime },
      extensions: [],
    });

    try {
      await runWithBunServices(
        engine.runSync({
          runId,
          programPath: "/tmp/program.ts",
          executeProgram: (task) =>
            Effect.flatMap(
              task({
                agent: codex("openai/gpt-5.3-codex"),
                system: "You are concise.",
                prompt: "Inspect this run",
                role: "scout",
              }),
              () => Effect.void,
            ),
        }),
      );

      const inspectedRun = await runWithBunServices(engine.inspect({ runId }));
      expect(inspectedRun.kind).toBe("run");

      if (inspectedRun.kind === "run") {
        expect(inspectedRun.run.id).toBe(runId);
        expect(inspectedRun.events.length).toBeGreaterThan(0);
      }

      const taskStart = inspectedRun.events.find((event) => event.type === "task:start");
      expect(taskStart).toBeDefined();

      if (taskStart === undefined || taskStart.type !== "task:start") {
        return;
      }

      const inspectedTask = await runWithBunServices(
        engine.inspect({ runId, taskId: taskStart.payload.taskId }),
      );

      expect(inspectedTask.kind).toBe("task");

      if (inspectedTask.kind === "task") {
        expect(inspectedTask.taskId).toBe(taskStart.payload.taskId);
        expect(inspectedTask.result?.sessionRef).toBe("session/scout");
      }
    } finally {
      await rm(runsDirectory, { recursive: true, force: true });
    }
  });

  it("watch and watchIo surface tier-1 persisted events and io passthrough", async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), "mill-engine-watch-"));
    const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);

    const driverWithRaw: AgentRuntime = {
      name: "test-agent-runtime",
      createSession: (input) =>
        Effect.succeed({
          sessionRef: `session/${input.role}`,
          startTurn: (turn) =>
            Effect.succeed({
              raw: [
                JSON.stringify({ type: "milestone", message: `raw:${input.role}` }),
                JSON.stringify({ type: "final", sessionRef: `session/${input.role}` }),
              ],
              events: [
                {
                  type: "milestone",
                  message: `started:${input.role}`,
                },
              ],
              result: {
                text: `agent:${turn.prompt}`,
                sessionRef: `session/${input.role}`,
                role: input.role,
                model: input.model,
                provider: "test-agent-runtime",
                exitCode: 0,
              },
            }),
          cancelTurn: () => Effect.void,
          close: () => Effect.void,
        }),
    };

    const engine = makeMillEngine({
      runsDirectory,
      agentRuntimes: { default: driverWithRaw, codex: driverWithRaw },
      extensions: [],
    });

    try {
      await runWithBunServices(
        engine.submit({
          runId,
          programPath: "/tmp/program.ts",
        }),
      );

      const watchTier1Effect = Effect.scoped(
        Stream.runCollect(
          Stream.takeUntil(
            engine.watch(runId),
            (event) =>
              event.type === "run:complete" ||
              event.type === "run:failed" ||
              event.type === "run:cancelled",
          ),
        ),
      );

      const watchIoEffect = Effect.scoped(Stream.runCollect(Stream.take(engine.watchIo(runId), 2)));

      const executionEffect = engine.runSync({
        runId,
        programPath: "/tmp/program.ts",
        executeProgram: (task) =>
          Effect.flatMap(
            task({
              agent: codex("openai/gpt-5.3-codex"),
              system: "You are concise.",
              prompt: "watch this run",
              role: "scout",
            }),
            () => Effect.void,
          ),
      });

      const [tier1EventsChunk, ioEventsChunk] = await runWithBunServices(
        Effect.map(
          Effect.all([watchTier1Effect, watchIoEffect, executionEffect], {
            concurrency: "unbounded",
          }),
          ([tier1Events, ioEvents]) => [tier1Events, ioEvents] as const,
        ),
      );

      const tier1Events = [...tier1EventsChunk];
      const ioEvents = [...ioEventsChunk];

      expect(tier1Events.some((event) => event.type === "run:start")).toBe(true);
      expect(tier1Events.some((event) => event.type === "run:complete")).toBe(true);
      expect(ioEvents).toHaveLength(2);
      expect(ioEvents[0]?.source).toBe("agent");
      expect(ioEvents[0]?.stream).toBe("stdout");
      expect(ioEvents[0]?.line).toContain("raw:scout");

      const eventsFile = await readFile(join(runsDirectory, runId, "events.ndjson"), "utf-8");
      expect(eventsFile.includes('"type":"final"')).toBe(false);
    } finally {
      await rm(runsDirectory, { recursive: true, force: true });
    }
  });

  it("cancel is idempotent and appends at most one run:cancelled terminal event", async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), "mill-engine-cancel-"));
    const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);

    const store = makeRunStore({ runsDirectory });
    const engine = makeMillEngine({
      runsDirectory,
      agentRuntimes: { default: testRuntime, codex: testRuntime },
      extensions: [],
    });

    try {
      await runWithBunServices(
        store.create({
          runId,
          programPath: "/tmp/program.ts",
          status: "running",
          timestamp: "2026-02-23T20:00:00.000Z",
        }),
      );

      await runWithBunServices(
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

      await runWithBunServices(engine.cancel(runId));
      await runWithBunServices(engine.cancel(runId));

      const run = await runWithBunServices(engine.status(runId));
      expect(run.status).toBe("cancelled");

      const events = await runWithBunServices(store.readEvents(runId));
      const cancelledCount = events.filter((event) => event.type === "run:cancelled").length;
      const terminalCount = events.filter((event) => runTerminalTypes.has(event.type)).length;

      expect(cancelledCount).toBe(1);
      expect(terminalCount).toBe(1);
    } finally {
      await rm(runsDirectory, { recursive: true, force: true });
    }
  });
});
