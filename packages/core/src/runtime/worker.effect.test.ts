import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { decodeMillEventJsonSync } from "../domain/event.schema";
import { decodeRunIdSync } from "../domain/run.schema";
import { runWithBunContext } from "../public/test-runtime.api";
import type { DriverRuntime } from "../public/types";
import { makeMillEngine } from "../internal/engine.effect";
import { makeRunStore } from "../internal/run-store.effect";
import { runDetachedWorker } from "./worker.effect";

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

describe("runDetachedWorker", () => {
  it("finalizes exactly once and is idempotent on subsequent invocations", async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), "mill-worker-"));
    const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);

    const store = makeRunStore({ runsDirectory });
    const engine = makeMillEngine({
      runsDirectory,
      defaultModel: "openai/gpt-5.3-codex",
      driverName: "default",
      executorName: "direct",
      driver: testDriver,
      extensions: [],
    });

    try {
      const submittedRun = await runWithBunContext(
        store.create({
          runId,
          programPath: "/tmp/program.ts",
          driver: "default",
          executor: "direct",
          status: "pending",
          timestamp: "2026-02-23T20:00:00.000Z",
        }),
      );

      const firstRun = await runWithBunContext(
        runDetachedWorker({
          runId,
          programPath: submittedRun.programPath,
          runsDirectory,
          engine,
          executeProgram: (spawn) =>
            Effect.gen(function* () {
              const result = yield* spawn({
                agent: "scout",
                systemPrompt: "You are concise.",
                prompt: "Say hello",
              });

              expect(result.sessionRef.length).toBeGreaterThan(0);
            }),
        }),
      );

      expect(firstRun.run.status).toBe("complete");

      const secondRun = await runWithBunContext(
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
