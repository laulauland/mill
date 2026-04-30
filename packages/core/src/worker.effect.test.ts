import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { decodeMillEventJsonSync } from "./event.schema";
import { decodeRunIdSync } from "./run.schema";
import { runWithBunServices } from "./test-runtime";
import type { AgentRuntime } from "./types";
import { makeMillEngine } from "./engine.effect";
import { makeRunStore } from "./run-store.effect";
import { runDetachedWorker } from "./worker.effect";
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
            driver: "test-provider",
            exitCode: 0,
          },
        }),
      cancelTurn: () => Effect.void,
      close: () => Effect.void,
    }),
};

describe("runDetachedWorker", () => {
  it("finalizes exactly once and is idempotent on subsequent invocations", async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), "mill-worker-"));
    const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);

    const store = makeRunStore({ runsDirectory });
    const engine = makeMillEngine({
      runsDirectory,
      agentRuntimes: { default: testRuntime, codex: testRuntime },
      extensions: [],
    });

    try {
      const submittedRun = await runWithBunServices(
        store.create({
          runId,
          programPath: "/tmp/program.ts",
          status: "pending",
          timestamp: "2026-02-23T20:00:00.000Z",
        }),
      );

      const firstRun = await runWithBunServices(
        runDetachedWorker({
          runId,
          programPath: submittedRun.programPath,
          runsDirectory,
          engine,
          executeProgram: (task) =>
            Effect.gen(function* () {
              const result = yield* task({
                agent: codex("openai/gpt-5.3-codex"),
                system: "You are concise.",
                prompt: "Say hello",
                role: "scout",
              });

              expect(result.sessionRef.length).toBeGreaterThan(0);
            }),
        }),
      );

      expect(firstRun.run.status).toBe("complete");

      const secondRun = await runWithBunServices(
        runDetachedWorker({
          runId,
          programPath: submittedRun.programPath,
          runsDirectory,
          engine,
          executeProgram: () =>
            Effect.die(new Error("second worker invocation must not re-execute program")),
        }),
      );

      expect(secondRun.run.status).toBe("complete");

      const eventsContent = await readFile(firstRun.run.paths.eventsFile, "utf-8");
      const events = eventsContent
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => decodeMillEventJsonSync(line));

      const runTerminalEvents = events.filter(
        (event) =>
          event.type === "run:complete" ||
          event.type === "run:failed" ||
          event.type === "run:cancelled",
      );

      expect(runTerminalEvents).toHaveLength(1);

      const workerLog = await readFile(
        join(firstRun.run.paths.runDir, "logs", "worker.log"),
        "utf-8",
      );
      expect(workerLog).toContain("worker:start");
      expect(workerLog).toContain("worker:complete");
    } finally {
      await rm(runsDirectory, { recursive: true, force: true });
    }
  });
});
