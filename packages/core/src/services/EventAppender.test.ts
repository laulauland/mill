import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import * as BunServices from "@effect/platform-bun/BunServices";
import { EventAppender, EventAppenderLive } from "./EventAppender";
import { PathService, PathServiceLive } from "./PathService";
import type { TaskEvent } from "../schemas/task-event";

const makeTestLayer = (dir: string) =>
  EventAppenderLive.pipe(
    Layer.provide(PathServiceLive(dir)),
    Layer.provide(BunServices.layer),
  );

describe("EventAppender", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = `/tmp/mill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    try { require("fs").rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const run = <E, A>(effect: Effect.Effect<A, E, EventAppender | PathService>) => {
    const layer = makeTestLayer(tmpDir);
    const program = Effect.provide(effect, layer);
    return Effect.runPromise(program);
  };

  const makeEvent = (type: TaskEvent["type"], taskId: string, overrides: Partial<TaskEvent> = {}): TaskEvent =>
    ({
      taskId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      type,
      payload: {},
      ...overrides,
    }) as TaskEvent;

  test("append creates directory and events file", async () => {
    const appender = await run(Effect.gen(function* () {
      const ea = yield* EventAppender;
      yield* ea.append("root1", makeEvent("task:created", "root1", { payload: { kind: "program" } }));
      return ea;
    }));

    const events = await run(appender.readEvents("root1"));
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("task:created");
  });

  test("sequence numbers increment", async () => {
    const appender = await run(Effect.gen(function* () {
      const ea = yield* EventAppender;
      yield* ea.append("root1", makeEvent("task:created", "root1", { payload: { kind: "program" } }));
      yield* ea.append("root1", makeEvent("task:started", "root1"));
      return ea;
    }));

    const events = await run(appender.readEvents("root1"));
    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(2);
  });

  test("lifecycle validation prevents starting an already started task", async () => {
    const result = await run(Effect.gen(function* () {
      const ea = yield* EventAppender;
      yield* ea.append("root1", makeEvent("task:created", "root1", { payload: { kind: "program" } }));
      yield* ea.append("root1", makeEvent("task:started", "root1"));
      return yield* Effect.exit(ea.append("root1", makeEvent("task:started", "root1")));
    }));

    expect(Exit.isFailure(result)).toBe(true);
  });

  test("turn lifecycle validation rejects invalid ordering", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ea = yield* EventAppender;
        yield* ea.append(
          "root1",
          makeEvent("task:created", "root1", { payload: { kind: "agent" } }),
        );
        yield* ea.append("root1", makeEvent("task:started", "root1"));

        const completedWithoutActiveTurn = yield* Effect.exit(
          ea.append(
            "root1",
            makeEvent("task:turn_completed", "root1", {
              payload: { text: "late", sequence: 1 },
            }),
          ),
        );

        yield* ea.append(
          "root1",
          makeEvent("task:turn_started", "root1", {
            payload: { prompt: "hello", sequence: 1 },
          }),
        );

        const overlappingTurn = yield* Effect.exit(
          ea.append(
            "root1",
            makeEvent("task:turn_started", "root1", {
              payload: { prompt: "again", sequence: 2 },
            }),
          ),
        );

        const mismatchedCompletion = yield* Effect.exit(
          ea.append(
            "root1",
            makeEvent("task:turn_completed", "root1", {
              payload: { text: "wrong", sequence: 2 },
            }),
          ),
        );

        const completedWhileBusy = yield* Effect.exit(
          ea.append("root1", makeEvent("task:completed", "root1", { payload: { result: "done" } })),
        );

        return {
          completedWithoutActiveTurn,
          overlappingTurn,
          mismatchedCompletion,
          completedWhileBusy,
        };
      }),
    );

    expect(Exit.isFailure(result.completedWithoutActiveTurn)).toBe(true);
    expect(Exit.isFailure(result.overlappingTurn)).toBe(true);
    expect(Exit.isFailure(result.mismatchedCompletion)).toBe(true);
    expect(Exit.isFailure(result.completedWhileBusy)).toBe(true);
  });

  test("turn lifecycle validation accepts matching turn boundaries", async () => {
    const events = await run(
      Effect.gen(function* () {
        const ea = yield* EventAppender;
        yield* ea.append(
          "root1",
          makeEvent("task:created", "root1", { payload: { kind: "agent" } }),
        );
        yield* ea.append("root1", makeEvent("task:started", "root1"));
        yield* ea.append(
          "root1",
          makeEvent("task:turn_started", "root1", {
            payload: { prompt: "hello", sequence: 1 },
          }),
        );
        yield* ea.append(
          "root1",
          makeEvent("task:turn_completed", "root1", {
            payload: { text: "world", sequence: 1 },
          }),
        );
        yield* ea.append(
          "root1",
          makeEvent("task:completed", "root1", { payload: { result: "world" } }),
        );
        return yield* ea.readEvents("root1");
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "task:created",
      "task:started",
      "task:turn_started",
      "task:turn_completed",
      "task:completed",
    ]);
  });

  test("child snapshot is written for non-root events", async () => {
    await run(Effect.gen(function* () {
      const ea = yield* EventAppender;
      yield* ea.append("root1", makeEvent("task:created", "root1", { payload: { kind: "program" } }));
      yield* ea.append("root1", makeEvent("task:child_spawned", "root1", { payload: { childId: "child1", kind: "agent" } }));
      return ea;
    }));

    const snapshotPath = `${tmpDir}/root1/tasks/child1.json`;
    const snapshot = require("fs").readFileSync(snapshotPath, "utf-8");
    expect(JSON.parse(snapshot)).toHaveProperty("id");
  });
});
