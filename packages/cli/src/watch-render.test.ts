import { describe, expect, test } from "bun:test";
import type { TaskEvent } from "@mill/core";
import { initialWatchModel, reduceWatchEvent } from "./watch-model";
import { renderWatchMilestone, renderWatchModel } from "./watch-render";

const event = (
  type: TaskEvent["type"],
  taskId: string,
  payload: unknown,
  sequence: number,
): TaskEvent =>
  ({
    taskId,
    sequence,
    timestamp: `2026-05-04T00:00:0${sequence}.000Z`,
    type,
    payload,
  }) as TaskEvent;

const reduce = (events: ReadonlyArray<TaskEvent>) =>
  events.reduce(reduceWatchEvent, initialWatchModel("task_root"));

describe("watch renderer", () => {
  test("coalesces chunks and pairs tools without leaking correlation ids by default", () => {
    const model = reduce([
      event(
        "task:created",
        "task_root",
        { kind: "program", input: "workflows/jj-change-workflow.ts" },
        0,
      ),
      event("task:started", "task_root", {}, 1),
      event(
        "task:child_spawned",
        "task_root",
        {
          childId: "task_child",
          kind: "agent",
          label: "research (claude-opus-4.7)",
          provider: "claude",
          model: "claude-opus-4.7",
        },
        2,
      ),
      event("task:created", "task_child", { parentId: "task_root", kind: "agent" }, 3),
      event("task:started", "task_child", {}, 4),
      event("task:turn_started", "task_child", { prompt: "research", sequence: 1 }, 5),
      event("task:thought_chunk", "task_child", { text: "Let me " }, 6),
      event("task:thought_chunk", "task_child", { text: "research the codebase." }, 7),
      event(
        "task:tool_called",
        "task_child",
        {
          toolCallId: "toolu_123",
          toolName: "find /Users/example/*.ts | grep cli",
          arguments: { input: "full" },
        },
        8,
      ),
      event(
        "task:tool_returned",
        "task_child",
        {
          toolCallId: "toolu_123",
          toolName: "find /Users/example/*.ts | grep cli",
          result: "packages/cli/src/mill.ts",
        },
        9,
      ),
      event("task:message_chunk", "task_child", { text: "Plan: " }, 10),
      event("task:message_chunk", "task_child", { text: "wire watch through model." }, 11),
    ]);

    const rendered = renderWatchModel(model, {
      columns: 80,
      now: Date.parse("2026-05-04T00:00:12.000Z"),
    });

    expect(rendered).toContain("workflows/jj-change-workflow.ts");
    expect(rendered).toContain("taskId: task_root");
    expect(rendered).toContain("research (claude-opus-4.7)");
    expect(rendered).toContain("▸ thought  Let me research the codebase.");
    expect(rendered).toContain("▸ tool     find /Users/example/*.ts | grep cli");
    expect(rendered).toContain("▸ output   Plan: wire watch through model.");
    expect(rendered).not.toContain("toolu_123");
  });

  test("verbose rendering includes tool correlation ids and arguments", () => {
    const model = reduce([
      event("task:child_spawned", "task_root", { childId: "task_child", kind: "agent" }, 1),
      event(
        "task:tool_called",
        "task_child",
        { toolCallId: "toolu_123", toolName: "Task", arguments: { input: "full" } },
        2,
      ),
    ]);

    const rendered = renderWatchModel(model, {
      verbose: true,
      now: Date.parse("2026-05-04T00:00:03.000Z"),
    });

    expect(rendered).toContain("toolu_123");
    expect(rendered).toContain('{"input":"full"}');
  });

  test("milestones only emit terminal transitions", () => {
    const previous = reduce([
      event("task:child_spawned", "task_root", { childId: "task_child", kind: "agent" }, 1),
    ]);
    const next = reduce([
      event("task:child_spawned", "task_root", { childId: "task_child", kind: "agent" }, 1),
      event("task:started", "task_child", {}, 2),
      event("task:completed", "task_child", { result: "ok" }, 3),
    ]);

    expect(
      renderWatchMilestone(previous, next, { now: Date.parse("2026-05-04T00:00:04.000Z") }),
    ).toContain("✓ agent completed");
  });
});
