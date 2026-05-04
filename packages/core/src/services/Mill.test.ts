import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Mill, MillLive } from "./Mill";
import { EntityRegistry, EntityRegistryLive } from "./EntityRegistry";
import { EventAppender, EventAppenderLive } from "./EventAppender";
import { PathService, PathServiceLive } from "./PathService";
import { IdGenerator, IdGeneratorLive } from "./IdGenerator";
import { ProgramHostLive } from "./ProgramHost";
import { AgentRuntimeStub } from "./AgentRuntime";

const makeTestLayer = (dir: string) => {
  const fsLayer = EventAppenderLive.pipe(
    Layer.provide(PathServiceLive(dir)),
    Layer.provide(BunServices.layer),
  );
  const registryLayer = EntityRegistryLive.pipe(
    Layer.provide(fsLayer),
    Layer.provide(IdGeneratorLive),
  );
  // Mill needs EntityRegistry; EntityRegistry methods need EventAppender+IdGenerator at runtime
  const millLayer = MillLive.pipe(
    Layer.provide(registryLayer),
    Layer.provide(
      ProgramHostLive.pipe(
        Layer.provide(registryLayer),
        Layer.provide(fsLayer),
        Layer.provide(AgentRuntimeStub),
      ),
    ),
    Layer.provide(Layer.mergeAll(fsLayer, IdGeneratorLive)),
  );
  return Layer.mergeAll(millLayer, registryLayer, fsLayer, IdGeneratorLive);
};

describe("Mill", () => {
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
    effect: Effect.Effect<A, E, Mill | EntityRegistry | EventAppender | PathService | IdGenerator>,
  ) => {
    const layer = makeTestLayer(tmpDir);
    const program = Effect.provide(effect, layer);
    return Effect.runPromise(program);
  };

  test("submit creates a program task", async () => {
    const taskId = await run(
      Effect.gen(function* () {
        const mill = yield* Mill;
        return yield* mill.submit("/path/to/program.ts");
      }),
    );

    expect(typeof taskId).toBe("string");
    expect(taskId.startsWith("task_")).toBe(true);
  });

  test("status returns snapshot for existing task", async () => {
    const fs = require("fs");
    const programPath = `${tmpDir}/long-program.ts`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      programPath,
      `export default async function() { await new Promise((resolve) => setTimeout(resolve, 250)); return "done"; };`,
    );

    const snapshot = await run(
      Effect.gen(function* () {
        const mill = yield* Mill;
        const taskId = yield* mill.submit(programPath);
        yield* Effect.sleep("50 millis");
        return yield* mill.status(taskId);
      }),
    );

    expect(snapshot.status).toBe("started");
  });

  test("send after terminal status rejects instead of hanging", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const mill = yield* Mill;
          const registry = yield* EntityRegistry;
          const entity = yield* registry.getOrCreate("task1", "task1");
          yield* entity.applyEvent({
            taskId: "task1",
            sequence: 1,
            timestamp: new Date().toISOString(),
            type: "task:cancelled",
            payload: { reason: "user" },
          });
          return yield* mill.send("task1", "late");
        }),
      ),
    ).rejects.toThrow("Cancelled");
  });

  test("concurrent sends resolve their matching turn result", async () => {
    const results = await run(
      Effect.gen(function* () {
        const mill = yield* Mill;
        const registry = yield* EntityRegistry;
        const eventAppender = yield* EventAppender;
        const entity = yield* registry.getOrCreate("task1", "task1");
        yield* entity.send({ _tag: "CreateTask", kind: "agent" });
        yield* Effect.sleep("50 millis");

        const firstFiber = yield* Effect.forkDetach(mill.send("task1", "first"));
        const secondFiber = yield* Effect.forkDetach(mill.send("task1", "second"));
        const firstPrompt = yield* Queue.take(entity.userInbox);
        const secondPrompt = yield* Queue.take(entity.userInbox);

        yield* eventAppender.append("task1", {
          taskId: "task1",
          sequence: 0,
          timestamp: new Date().toISOString(),
          type: "task:turn_started",
          payload: { prompt: firstPrompt.prompt, sequence: firstPrompt.sequence },
        });
        yield* eventAppender.append("task1", {
          taskId: "task1",
          sequence: 0,
          timestamp: new Date().toISOString(),
          type: "task:turn_completed",
          payload: { text: "first reply", sequence: firstPrompt.sequence },
        });
        yield* eventAppender.append("task1", {
          taskId: "task1",
          sequence: 0,
          timestamp: new Date().toISOString(),
          type: "task:turn_started",
          payload: { prompt: secondPrompt.prompt, sequence: secondPrompt.sequence },
        });
        yield* eventAppender.append("task1", {
          taskId: "task1",
          sequence: 0,
          timestamp: new Date().toISOString(),
          type: "task:turn_completed",
          payload: { text: "second reply", sequence: secondPrompt.sequence },
        });

        const first = yield* Fiber.join(firstFiber);
        const second = yield* Fiber.join(secondFiber);
        return { first, second, firstPrompt, secondPrompt };
      }),
    );

    expect(results.firstPrompt).toEqual({ prompt: "first", sequence: 1 });
    expect(results.secondPrompt).toEqual({ prompt: "second", sequence: 2 });
    expect(results.first).toEqual({ text: "first reply", sequence: 1 });
    expect(results.second).toEqual({ text: "second reply", sequence: 2 });
  });

  test("list returns root task ids", async () => {
    const ids = await run(
      Effect.gen(function* () {
        const mill = yield* Mill;
        yield* mill.submit("/path/to/program1.ts");
        yield* mill.submit("/path/to/program2.ts");
        return yield* mill.list();
      }),
    );

    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  test("list discovers persisted root task ids from a fresh process", async () => {
    const fs = require("fs");
    const rootA = "task_disk_root_a";
    const rootB = "task_disk_root_b";
    fs.mkdirSync(`${tmpDir}/${rootA}`, { recursive: true });
    fs.mkdirSync(`${tmpDir}/${rootB}`, { recursive: true });
    fs.writeFileSync(
      `${tmpDir}/${rootA}/events.ndjson`,
      `${JSON.stringify({ taskId: rootA, sequence: 1, timestamp: "2026-05-04T00:00:00.000Z", type: "task:created", payload: { kind: "program" } })}\n`,
    );
    fs.writeFileSync(
      `${tmpDir}/${rootB}/events.ndjson`,
      `${JSON.stringify({ taskId: rootB, sequence: 1, timestamp: "2026-05-04T00:00:00.000Z", type: "task:created", payload: { kind: "program" } })}\n`,
    );

    const ids = await run(
      Effect.gen(function* () {
        const mill = yield* Mill;
        return yield* mill.list();
      }),
    );

    expect(ids).toEqual([rootA, rootB]);
  });

  test("list --all includes child task ids from persisted events", async () => {
    const fs = require("fs");
    const rootId = "task_disk_root";
    const childId = "task_disk_child";
    fs.mkdirSync(`${tmpDir}/${rootId}`, { recursive: true });
    fs.writeFileSync(
      `${tmpDir}/${rootId}/events.ndjson`,
      [
        {
          taskId: rootId,
          sequence: 1,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:created",
          payload: { kind: "program" },
        },
        {
          taskId: rootId,
          sequence: 2,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:child_spawned",
          payload: { childId, kind: "agent" },
        },
        {
          taskId: childId,
          sequence: 3,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:created",
          payload: { parentId: rootId, kind: "agent" },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );

    const ids = await run(
      Effect.gen(function* () {
        const mill = yield* Mill;
        return yield* mill.list({ all: true });
      }),
    );

    expect(ids).toEqual([childId, rootId]);
  });

  test("watch replays persisted child subtree and applies include/exclude filters", async () => {
    const fs = require("fs");
    const rootId = "task_disk_root";
    const childId = "task_disk_child";
    fs.mkdirSync(`${tmpDir}/${rootId}`, { recursive: true });
    fs.writeFileSync(
      `${tmpDir}/${rootId}/events.ndjson`,
      [
        {
          taskId: rootId,
          sequence: 1,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:created",
          payload: { kind: "program" },
        },
        {
          taskId: rootId,
          sequence: 2,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:child_spawned",
          payload: { childId, kind: "agent" },
        },
        {
          taskId: childId,
          sequence: 3,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:created",
          payload: { parentId: rootId, kind: "agent" },
        },
        {
          taskId: childId,
          sequence: 4,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:message_chunk",
          payload: { text: "hello" },
        },
        {
          taskId: childId,
          sequence: 5,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:completed",
          payload: { result: "hello" },
        },
        {
          taskId: rootId,
          sequence: 6,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:completed",
          payload: { result: "done" },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );

    const replayed = await run(
      Effect.gen(function* () {
        const mill = yield* Mill;
        return yield* mill
          .watch(childId, {
            include: ["task:created", "task:message_chunk", "task:completed"],
            exclude: ["task:message_chunk"],
          })
          .pipe(Stream.take(2), Stream.runCollect);
      }),
    );

    expect(Array.from(replayed).map((event) => [event.taskId, event.type])).toEqual([
      [childId, "task:created"],
      [childId, "task:completed"],
    ]);
  });

  test("watch does not stop at root terminal before later child events", async () => {
    const fs = require("fs");
    const rootId = "task_disk_root";
    const childId = "task_disk_child";
    fs.mkdirSync(`${tmpDir}/${rootId}`, { recursive: true });
    fs.writeFileSync(
      `${tmpDir}/${rootId}/events.ndjson`,
      [
        {
          taskId: rootId,
          sequence: 1,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:created",
          payload: { kind: "program" },
        },
        {
          taskId: rootId,
          sequence: 2,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:child_spawned",
          payload: { childId, kind: "agent" },
        },
        {
          taskId: childId,
          sequence: 3,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:created",
          payload: { parentId: rootId, kind: "agent" },
        },
        {
          taskId: childId,
          sequence: 4,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:started",
          payload: {},
        },
        {
          taskId: rootId,
          sequence: 5,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:completed",
          payload: { result: "done" },
        },
        {
          taskId: childId,
          sequence: 6,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:message_chunk",
          payload: { text: "late child" },
        },
        {
          taskId: childId,
          sequence: 7,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:completed",
          payload: { result: "late child" },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );

    const watched = await run(
      Effect.gen(function* () {
        const mill = yield* Mill;
        const rootEvents = yield* mill.watch(rootId).pipe(Stream.take(7), Stream.runCollect);
        const childEvents = yield* mill.watch(childId).pipe(Stream.take(4), Stream.runCollect);
        return {
          rootEvents: Array.from(rootEvents).map((event) => `${event.taskId}:${event.type}`),
          childEvents: Array.from(childEvents).map((event) => `${event.taskId}:${event.type}`),
        };
      }),
    );

    expect(watched.rootEvents).toEqual([
      "task_disk_root:task:created",
      "task_disk_root:task:child_spawned",
      "task_disk_child:task:created",
      "task_disk_child:task:started",
      "task_disk_root:task:completed",
      "task_disk_child:task:message_chunk",
      "task_disk_child:task:completed",
    ]);
    expect(watched.childEvents).toEqual([
      "task_disk_child:task:created",
      "task_disk_child:task:started",
      "task_disk_child:task:message_chunk",
      "task_disk_child:task:completed",
    ]);
  });

  test("submit executes top-level program tasks and result resolves", async () => {
    const fs = require("fs");
    const programPath = `${tmpDir}/top-level-program.ts`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      programPath,
      [
        `import { task, codex } from "${import.meta.dir}/../program.api.ts";`,
        `const child = task({ agent: codex("gpt-5") });`,
        `child.send("review src");`,
        `child.complete();`,
        `await child.done;`,
        `console.log("child settled");`,
      ].join("\n"),
    );

    const result = await run(
      Effect.gen(function* () {
        const mill = yield* Mill;
        const taskId = yield* mill.submit(programPath);
        const taskResult = yield* mill.result(taskId);
        const snapshot = yield* mill.status(taskId);
        return { taskId, taskResult, snapshot };
      }),
    );

    expect(result.taskResult.status).toBe("completed");
    expect(result.taskResult.status === "completed" ? result.taskResult.output.text : "").toBe(
      "{}",
    );
    expect(result.snapshot.status).toBe("completed");
    expect(result.snapshot.text).toContain("child settled");
  });

  test("status and result replay terminal root and child tasks from disk", async () => {
    const fs = require("fs");
    const rootId = "task_disk_root";
    const childId = "task_disk_child";
    fs.mkdirSync(`${tmpDir}/${rootId}`, { recursive: true });
    fs.writeFileSync(
      `${tmpDir}/${rootId}/events.ndjson`,
      [
        {
          taskId: rootId,
          sequence: 1,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:created",
          payload: { kind: "program", input: "replay-program.ts" },
        },
        {
          taskId: rootId,
          sequence: 2,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:started",
          payload: {},
        },
        {
          taskId: rootId,
          sequence: 3,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:child_spawned",
          payload: { childId, kind: "agent" },
        },
        {
          taskId: childId,
          sequence: 4,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:created",
          payload: { parentId: rootId, kind: "agent" },
        },
        {
          taskId: childId,
          sequence: 5,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:started",
          payload: {},
        },
        {
          taskId: childId,
          sequence: 6,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:message_chunk",
          payload: { text: "persist me" },
        },
        {
          taskId: childId,
          sequence: 7,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:completed",
          payload: { result: "persist me" },
        },
        {
          taskId: rootId,
          sequence: 8,
          timestamp: "2026-05-04T00:00:00.000Z",
          type: "task:completed",
          payload: { result: "done" },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );

    const replayed = await run(
      Effect.gen(function* () {
        const mill = yield* Mill;
        const rootResult = yield* mill.result(rootId);
        const root = yield* mill.status(rootId);
        const child = yield* mill.status(childId);
        return { rootResult, root, child };
      }),
    );

    expect(replayed.root.status).toBe("completed");
    expect(replayed.child.status).toBe("completed");
    expect(replayed.rootResult.status).toBe("completed");
    expect(replayed.rootResult.status === "completed" ? replayed.rootResult.output.kind : "").toBe(
      "agent",
    );
    expect(replayed.child.output?.text).toContain("persist me");
  });
});
