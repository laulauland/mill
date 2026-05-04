import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeAcpProvider } from "./AcpProvider";

describe("AcpProvider", () => {
  test("makeAcpProvider creates provider with correct name", async () => {
    const provider = await Effect.runPromise(
      makeAcpProvider({ name: "test-provider", command: "echo", args: ["hello"] }),
    );
    expect(provider.name).toBe("test-provider");
    expect(typeof provider.createSession).toBe("function");
    expect(typeof provider.mapToTaskEvent).toBe("function");
  });

  test("mapToTaskEvent maps text message to task:message_chunk", async () => {
    const provider = await Effect.runPromise(
      makeAcpProvider({ name: "test", command: "echo", args: [] }),
    );
    const event = provider.mapToTaskEvent("hello world", "task-1", 1);
    expect(event.type).toBe("task:message_chunk");
    expect(event.taskId).toBe("task-1");
    expect(event.sequence).toBe(1);
  });

  test("mapToTaskEvent maps tool_call to task:tool_called", async () => {
    const provider = await Effect.runPromise(
      makeAcpProvider({ name: "test", command: "echo", args: [] }),
    );
    const event = provider.mapToTaskEvent({ type: "tool_call", content: "readFile" }, "task-1", 2);
    expect(event.type).toBe("task:tool_called");
  });
});
