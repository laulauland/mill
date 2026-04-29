import { describe, expect, it } from "bun:test";
import { createTaskActor } from "./task-actor.api";
import { codex } from "./task.api";
import type { TaskInput, TaskResult, TaskSnapshot } from "./types";

const input: TaskInput = {
  agent: codex("openai-codex/gpt-5.3-codex"),
  prompt: "Review this repo.",
  role: "scout",
};

const successResult: TaskResult = {
  text: "done",
  sessionRef: "session/1",
  role: "scout",
  model: "openai-codex/gpt-5.3-codex",
  driver: "default",
  exitCode: 0,
};

const latest = (snapshots: ReadonlyArray<TaskSnapshot>): TaskSnapshot =>
  snapshots[snapshots.length - 1] as TaskSnapshot;

describe("TaskActor", () => {
  it("is created synchronously without starting work", async () => {
    let executeCount = 0;
    const actor = createTaskActor(input, {
      execute: () => {
        executeCount += 1;
        return Promise.resolve(successResult);
      },
      runId: "run_test",
      taskId: "task_test",
    });

    expect(actor.id).toBe("task_test");
    expect(actor.ref).toEqual({ runId: "run_test", taskId: "task_test" });
    expect(actor.getSnapshot().status).toBe("idle");
    expect(executeCount).toBe(0);

    actor.start();
    const result = await actor.done;

    expect(result).toEqual(successResult);
    expect(executeCount).toBe(1);
    expect(actor.getSnapshot()).toMatchObject({
      status: "complete",
      text: "done",
      sessionRef: "session/1",
      result: successResult,
    });
  });

  it("publishes snapshot updates and guards duplicate starts", async () => {
    let executeCount = 0;
    const snapshots: Array<TaskSnapshot> = [];
    const actor = createTaskActor(input, {
      execute: () => {
        executeCount += 1;
        return Promise.resolve(successResult);
      },
    });

    const subscription = actor.subscribe((snapshot) => {
      snapshots.push(snapshot);
    });

    actor.start().start();
    await actor.done;
    subscription.unsubscribe();

    expect(executeCount).toBe(1);
    expect(snapshots.map((snapshot) => snapshot.status)).toEqual(["idle", "running", "complete"]);
    expect(latest(snapshots).result).toEqual(successResult);
  });

  it("records unsupported steering commands without claiming steering semantics", () => {
    const actor = createTaskActor(input, {
      execute: () => Promise.resolve(successResult),
    });

    actor.send({
      type: "message",
      content: "Also inspect tests.",
    });

    expect(actor.getSnapshot()).toMatchObject({
      status: "idle",
      error: "Task steering commands are not implemented yet.",
    });
  });

  it("can be cancelled before start", async () => {
    let executeCount = 0;
    const actor = createTaskActor(input, {
      execute: () => {
        executeCount += 1;
        return Promise.resolve(successResult);
      },
    });

    actor.cancel("not needed").start();
    const result = await actor.done;

    expect(executeCount).toBe(0);
    expect(result.stopReason).toBe("cancelled");
    expect(result.errorMessage).toBe("not needed");
    expect(actor.getSnapshot()).toMatchObject({
      status: "cancelled",
      error: "not needed",
    });
  });

  it("captures task failures in the snapshot and done promise", async () => {
    const error = new Error("boom");
    const actor = createTaskActor(input, {
      execute: () => Promise.reject(error),
    });

    actor.start();

    await expect(actor.done).rejects.toThrow("boom");
    expect(actor.getSnapshot()).toMatchObject({
      status: "failed",
      error: "boom",
    });
  });
});
