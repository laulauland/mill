import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { decodeMillEventJsonSync } from "../domain/event.schema";
import { decodeRunIdSync } from "../domain/run.schema";
import { runWithBunContext } from "../public/test-runtime.api";
import { makeRunStore } from "./run-store.effect";

describe("RunStore", () => {
  it("creates run artifacts and appends tier-1 events as NDJSON", async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), "mill-run-store-"));
    const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);

    const store = makeRunStore({ runsDirectory });

    try {
      const runRecord = await runWithBunContext(
        store.create({
          runId,
          programPath: "/tmp/program.ts",
          driver: "default",
          timestamp: "2026-02-23T20:00:00.000Z",
        }),
      );

      expect(runRecord.paths.runFile.endsWith("run.json")).toBe(true);
      expect(runRecord.paths.eventsFile.endsWith("events.ndjson")).toBe(true);
      expect(runRecord.paths.resultFile.endsWith("result.json")).toBe(true);

      await runWithBunContext(
        store.appendEvent(runId, {
          schemaVersion: 1,
          runId,
          sequence: 1,
          timestamp: "2026-02-23T20:00:01.000Z",
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
          timestamp: "2026-02-23T20:00:02.000Z",
          type: "run:status",
          payload: {
            status: "running",
          },
        }),
      );

      const eventsFile = await readFile(runRecord.paths.eventsFile, "utf-8");
      const lines = eventsFile
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      expect(lines).toHaveLength(2);

      const firstEvent = decodeMillEventJsonSync(lines[0]);
      const secondEvent = decodeMillEventJsonSync(lines[1]);

      expect(firstEvent.type).toBe("run:start");
      expect(secondEvent.type).toBe("run:status");
    } finally {
      await rm(runsDirectory, { recursive: true, force: true });
    }
  });

  it("rejects terminal to non-terminal status transitions", async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), "mill-run-store-transition-"));
    const runId = decodeRunIdSync(`run_${crypto.randomUUID()}`);

    const store = makeRunStore({ runsDirectory });

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

      const transitionError = await runWithBunContext(
        Effect.flip(store.setStatus(runId, "running", "2026-02-23T20:00:03.000Z")),
      );

      expect(transitionError).toMatchObject({
        _tag: "LifecycleInvariantError",
        runId,
      });
    } finally {
      await rm(runsDirectory, { recursive: true, force: true });
    }
  });
});
