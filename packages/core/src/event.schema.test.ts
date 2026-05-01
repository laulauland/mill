import { describe, expect, it } from "bun:test";
import { decodeMillEventJsonSync } from "./event.schema";

describe("MillEvent schema union", () => {
  it("decodes persisted task:complete events with required envelope fields", () => {
    const event = decodeMillEventJsonSync(
      JSON.stringify({
        schemaVersion: 1,
        runId: "run_test_01",
        sequence: 5,
        timestamp: "2026-02-23T20:00:00.000Z",
        type: "task:complete",
        payload: {
          taskId: "task_01",
          result: {
            text: "done",
            sessionRef: "session/pi/test",
            role: "scout",
            model: "openai/gpt-5.3-codex",
            provider: "pi",
            exitCode: 0,
          },
        },
      }),
    );

    expect(event.schemaVersion).toBe(1);
    expect(event.runId).toBe("run_test_01");
    expect(event.sequence).toBe(5);
    expect(event.timestamp).toBe("2026-02-23T20:00:00.000Z");
    expect(event.type).toBe("task:complete");

    if (event.type === "task:complete") {
      expect(event.payload.result.sessionRef.length).toBeGreaterThan(0);
    }
  });

  it("fails decoding unknown schemaVersion values", () => {
    expect(() =>
      decodeMillEventJsonSync(
        JSON.stringify({
          schemaVersion: 2,
          runId: "run_test_01",
          sequence: 1,
          timestamp: "2026-02-23T20:00:00.000Z",
          type: "run:start",
          payload: {
            programPath: "/tmp/program.ts",
          },
        }),
      ),
    ).toThrow();
  });
});
