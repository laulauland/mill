import { describe, expect, test } from "bun:test";
import { reduceEvents, isTerminalStatus } from "./task-reducer";
import type { TaskEvent } from "./schemas/task-event";

describe("task-reducer", () => {
  const taskId = "task_123";

  const makeEvent = (type: TaskEvent["type"], overrides: Partial<TaskEvent> = {}): TaskEvent =>
    ({
      taskId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      type,
      payload: {},
      ...overrides,
    }) as TaskEvent;

  test("initial state is created", () => {
    const state = reduceEvents(taskId, []);
    expect(state.snapshot.status).toBe("created");
    expect(state.snapshot.id).toBe(taskId);
    expect(state.snapshot.text).toBe("");
    expect(state.snapshot.busy).toBe(false);
    expect(state.snapshot.history).toEqual([]);
  });

  test("task:created sets kind context", () => {
    const state = reduceEvents(taskId, [
      makeEvent("task:created", { payload: { kind: "agent", input: "hello" } }),
    ]);
    expect(state.snapshot.status).toBe("created");
  });

  test("task:started transitions to started", () => {
    const state = reduceEvents(taskId, [makeEvent("task:created"), makeEvent("task:started")]);
    expect(state.snapshot.status).toBe("started");
    expect(state.snapshot.busy).toBe(false);
  });

  test("turn events track per-turn text and history", () => {
    const state = reduceEvents(taskId, [
      makeEvent("task:started"),
      makeEvent("task:turn_started", { payload: { prompt: "first", sequence: 1 } }),
      makeEvent("task:message_chunk", { payload: { text: "hello" } }),
      makeEvent("task:turn_completed", { payload: { text: "hello", sequence: 1 } }),
      makeEvent("task:turn_started", { payload: { prompt: "second", sequence: 2 } }),
    ]);

    expect(state.snapshot.text).toBe("");
    expect(state.snapshot.busy).toBe(true);
    expect(state.snapshot.history).toEqual([{ prompt: "first", text: "hello" }]);
  });

  test("message chunks fold into text", () => {
    const state = reduceEvents(taskId, [
      makeEvent("task:message_chunk", { payload: { text: "hello " } }),
      makeEvent("task:message_chunk", { payload: { text: "world" } }),
    ]);
    expect(state.snapshot.text).toBe("hello world");
  });

  test("thought chunks fold into thought", () => {
    const state = reduceEvents(taskId, [
      makeEvent("task:thought_chunk", { payload: { text: "thinking..." } }),
    ]);
    expect(state.snapshot.thought).toBe("thinking...");
  });

  test("task:completed sets terminal state", () => {
    const state = reduceEvents(taskId, [
      makeEvent("task:created"),
      makeEvent("task:started"),
      makeEvent("task:completed", { payload: { result: "done" } }),
    ]);
    expect(state.snapshot.status).toBe("completed");
    expect(state.snapshot.busy).toBe(false);
    expect(state.snapshot.output).toEqual({ kind: "agent", text: "done" });
  });

  test("task:failed sets failed status without snapshot error", () => {
    const state = reduceEvents(taskId, [makeEvent("task:failed", { payload: { error: "boom" } })]);
    expect(state.snapshot.status).toBe("failed");
    expect(state.snapshot.output).toBeUndefined();
  });

  test("task:cancelled sets cancelled", () => {
    const state = reduceEvents(taskId, [
      makeEvent("task:cancelled", { payload: { reason: "user" } }),
    ]);
    expect(state.snapshot.status).toBe("cancelled");
    expect(state.snapshot.output).toBeUndefined();
  });

  test("child_spawned accumulates children", () => {
    const state = reduceEvents(taskId, [
      makeEvent("task:child_spawned", { payload: { childId: "child1", kind: "agent" } }),
      makeEvent("task:child_spawned", { payload: { childId: "child2", kind: "agent" } }),
    ]);
    expect(state.children).toEqual(["child1", "child2"]);
  });
});

describe("isTerminalStatus", () => {
  test("created is not terminal", () => {
    expect(isTerminalStatus("created")).toBe(false);
  });
  test("started is not terminal", () => {
    expect(isTerminalStatus("started")).toBe(false);
  });
  test("completed is terminal", () => {
    expect(isTerminalStatus("completed")).toBe(true);
  });
  test("failed is terminal", () => {
    expect(isTerminalStatus("failed")).toBe(true);
  });
  test("cancelled is terminal", () => {
    expect(isTerminalStatus("cancelled")).toBe(true);
  });
});
