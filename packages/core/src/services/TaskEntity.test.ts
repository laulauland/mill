import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Effect, Layer, Queue } from "effect";
import * as BunServices from "@effect/platform-bun/BunServices";
import { EntityRegistry, EntityRegistryLive } from "./EntityRegistry";
import { EventAppender, EventAppenderLive } from "./EventAppender";
import { PathService, PathServiceLive } from "./PathService";
import { IdGenerator, IdGeneratorLive } from "./IdGenerator";
import { TaskCancelledError, TaskFailedError, TaskTerminalError } from "../schemas/task-state";

const makeTestLayer = (dir: string) => {
  const appenderLayer = EventAppenderLive.pipe(
    Layer.provide(PathServiceLive(dir)),
    Layer.provide(BunServices.layer),
  );
  return EntityRegistryLive.pipe(Layer.provide(appenderLayer), Layer.provide(IdGeneratorLive));
};

describe("TaskEntity", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = `/tmp/mill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    try {
      require("fs").rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  const run = <E, A>(
    effect: Effect.Effect<A, E, EntityRegistry | EventAppender | PathService | IdGenerator>,
  ) => {
    const layer = makeTestLayer(tmpDir);
    const program = Effect.provide(effect, layer);
    return Effect.runPromise(program);
  };

  test("entity can be created and queried", async () => {
    const entity = await run(
      Effect.gen(function* () {
        const registry = yield* EntityRegistry;
        const entity = yield* registry.getOrCreate("task1", "root1");
        yield* entity.send({ _tag: "CreateTask", kind: "program", input: "test" });
        yield* Effect.sleep("50 millis");
        return entity;
      }),
    );

    const snapshot = await run(entity.snapshot);
    expect(snapshot.id).toBe("task1");
    expect(snapshot.status).toBe("created");
  });

  test("send command implicitly starts and enqueues prompt", async () => {
    const state = await run(
      Effect.gen(function* () {
        const registry = yield* EntityRegistry;
        const entity = yield* registry.getOrCreate("task1", "root1");
        yield* entity.send({ _tag: "CreateTask", kind: "program" });
        yield* entity.send({ _tag: "SendMessage", taskId: "task1", content: "hello" });
        yield* Effect.sleep("50 millis");
        const snapshot = yield* entity.snapshot;
        const prompt = yield* Queue.take(entity.userInbox);
        return { snapshot, prompt };
      }),
    );

    expect(state.snapshot.status).toBe("started");
    expect(state.prompt).toEqual({ prompt: "hello", sequence: 1 });
    expect(state.snapshot.text).toBe("");
  });

  test("await resolves completed output and result narrows success", async () => {
    const settled = await run(
      Effect.gen(function* () {
        const registry = yield* EntityRegistry;
        const entity = yield* registry.getOrCreate("task1", "root1");
        yield* entity.applyEvent({
          taskId: "task1",
          sequence: 1,
          timestamp: new Date().toISOString(),
          type: "task:completed",
          payload: { result: "done" },
        });
        const output = yield* entity.await;
        const result = yield* entity.result;
        return { output, result };
      }),
    );

    expect(settled.output).toEqual({ kind: "agent", text: "done" });
    expect(settled.result).toEqual({
      status: "completed",
      output: { kind: "agent", text: "done" },
    });
  });

  test("await rejects failed and result returns failed variant", async () => {
    const settled = await run(
      Effect.gen(function* () {
        const registry = yield* EntityRegistry;
        const entity = yield* registry.getOrCreate("task1", "root1");
        yield* entity.applyEvent({
          taskId: "task1",
          sequence: 1,
          timestamp: new Date().toISOString(),
          type: "task:failed",
          payload: { error: "boom" },
        });
        const result = yield* entity.result;
        return { entity, result };
      }),
    );

    expect(settled.result.status).toBe("failed");
    if (settled.result.status === "failed") {
      expect(settled.result.error).toBeInstanceOf(TaskFailedError);
      expect(settled.result.error).toBeInstanceOf(TaskTerminalError);
      expect(settled.result.error.message).toBe("boom");
    }
    await expect(Effect.runPromise(settled.entity.await)).rejects.toBeInstanceOf(TaskFailedError);
  });

  test("mid-turn send records ephemeral pending prompt", async () => {
    const state = await run(
      Effect.gen(function* () {
        const registry = yield* EntityRegistry;
        const entity = yield* registry.getOrCreate("task1", "root1");
        yield* entity.applyEvent({
          taskId: "task1",
          sequence: 1,
          timestamp: new Date().toISOString(),
          type: "task:started",
          payload: {},
        });
        yield* entity.applyEvent({
          taskId: "task1",
          sequence: 2,
          timestamp: new Date().toISOString(),
          type: "task:turn_started",
          payload: { prompt: "first", sequence: 1 },
        });
        yield* entity.send({ _tag: "SendMessage", taskId: "task1", content: "second" });
        yield* Effect.sleep("50 millis");
        const snapshot = yield* entity.snapshot;
        const prompt = yield* Queue.take(entity.userInbox);
        return { snapshot, prompt };
      }),
    );

    expect(state.snapshot.pending).toEqual({ type: "message", content: "second" });
    expect(state.prompt).toEqual({ prompt: "second", sequence: 1 });
  });

  test("send after terminal status rejects instead of hanging", async () => {
    const entity = await run(
      Effect.gen(function* () {
        const registry = yield* EntityRegistry;
        const entity = yield* registry.getOrCreate("task1", "root1");
        yield* entity.applyEvent({
          taskId: "task1",
          sequence: 1,
          timestamp: new Date().toISOString(),
          type: "task:cancelled",
          payload: { reason: "user" },
        });
        return entity;
      }),
    );

    await expect(
      Effect.runPromise(entity.send({ _tag: "SendMessage", taskId: "task1", content: "late" })),
    ).rejects.toThrow("Task is already terminal");
  });

  test("cancel signals completion to unblock idle runtimes", async () => {
    const settled = await run(
      Effect.gen(function* () {
        const registry = yield* EntityRegistry;
        const entity = yield* registry.getOrCreate("task1", "root1");
        yield* entity.cancel("user");
        return yield* Effect.race(
          entity.completionSignal.pipe(Effect.as("completed" as const)),
          Effect.sleep("1 second").pipe(Effect.as("timeout" as const)),
        );
      }),
    );

    expect(settled).toBe("completed");
  });

  test("await rejects cancelled and result returns cancelled variant", async () => {
    const settled = await run(
      Effect.gen(function* () {
        const registry = yield* EntityRegistry;
        const entity = yield* registry.getOrCreate("task1", "root1");
        yield* entity.applyEvent({
          taskId: "task1",
          sequence: 1,
          timestamp: new Date().toISOString(),
          type: "task:cancelled",
          payload: { reason: "user" },
        });
        const result = yield* entity.result;
        return { entity, result };
      }),
    );

    expect(settled.result.status).toBe("cancelled");
    if (settled.result.status === "cancelled") {
      expect(settled.result.error).toBeInstanceOf(TaskCancelledError);
      expect(settled.result.error).toBeInstanceOf(TaskTerminalError);
      expect(settled.result.error.message).toBe("user");
    }
    await expect(Effect.runPromise(settled.entity.await)).rejects.toBeInstanceOf(
      TaskCancelledError,
    );
  });

  test("registry lists active entities", async () => {
    const ids = await run(
      Effect.gen(function* () {
        const registry = yield* EntityRegistry;
        yield* registry.getOrCreate("task1", "root1");
        yield* registry.getOrCreate("task2", "root1");
        return yield* registry.list();
      }),
    );

    expect(ids).toContain("task1");
    expect(ids).toContain("task2");
  });
});
