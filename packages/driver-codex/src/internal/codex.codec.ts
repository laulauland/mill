import { Data, Effect } from "effect";
import type { DriverSpawnEvent, DriverSpawnOutput } from "@mill/core";

export class CodexCodecError extends Data.TaggedError("CodexCodecError")<{
  message: string;
}> {}

type DecodeCodexProcessInput = {
  readonly agent: string;
  readonly model: string;
  readonly spawnId: string;
};

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (record: JsonRecord, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const decodeJsonLine = (line: string): Effect.Effect<JsonRecord, CodexCodecError> =>
  Effect.flatMap(
    Effect.try({
      try: () => JSON.parse(line) as unknown,
      catch: (error) =>
        new CodexCodecError({
          message: String(error),
        }),
    }),
    (parsed) =>
      isRecord(parsed)
        ? Effect.succeed(parsed)
        : Effect.fail(
            new CodexCodecError({
              message: "line must decode to a JSON object",
            }),
          ),
  );

const extractToolName = (item: JsonRecord): string | undefined => {
  const directName = readString(item, "name") ?? readString(item, "tool_name");

  if (directName !== undefined) {
    return directName;
  }

  const command = readString(item, "command");

  if (command === undefined) {
    return undefined;
  }

  const [commandName] = command.split(" ");
  return commandName;
};

const extractItemText = (item: JsonRecord): string | undefined => {
  const text = readString(item, "text");

  if (text !== undefined) {
    return text;
  }

  const content = item.content;

  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts = content
    .map((entry) => {
      if (!isRecord(entry)) {
        return undefined;
      }

      if (readString(entry, "type") !== "text") {
        return undefined;
      }

      return readString(entry, "text");
    })
    .filter((value): value is string => value !== undefined && value.length > 0);

  if (textParts.length === 0) {
    return undefined;
  }

  return textParts.join("\n");
};

const isToolItemType = (itemType: string | undefined): boolean =>
  itemType === "command_execution" ||
  itemType === "function_call" ||
  itemType === "mcp_tool_call" ||
  itemType === "tool_call";

const isAssistantItemType = (itemType: string | undefined): boolean =>
  itemType === "agent_message" || itemType === "assistant_message";

const isTerminalType = (eventType: string | undefined): boolean =>
  eventType === "turn.completed" || eventType === "turn.failed" || eventType === "error";

export const decodeCodexProcessOutput = (
  output: string,
  input: DecodeCodexProcessInput,
): Effect.Effect<DriverSpawnOutput, CodexCodecError> =>
  Effect.gen(function* () {
    const lines = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const decodedLines = yield* Effect.forEach(lines, decodeJsonLine);

    const events: Array<DriverSpawnEvent> = [];
    let sessionRef: string | undefined;
    let responseText: string | undefined;
    let stopReason: string | undefined;
    let exitCode = 0;
    let errorMessage: string | undefined;
    let terminalSeen = false;

    for (const decoded of decodedLines) {
      const eventType = readString(decoded, "type");

      if (terminalSeen && !isTerminalType(eventType)) {
        return yield* Effect.fail(
          new CodexCodecError({
            message: `Non-terminal line ${eventType ?? "unknown"} emitted after terminal event.`,
          }),
        );
      }

      if (eventType === "thread.started") {
        const threadId = readString(decoded, "thread_id");

        if (threadId !== undefined) {
          sessionRef = threadId;
          events.push({
            type: "milestone",
            message: "thread:start",
          });
        }

        continue;
      }

      if (eventType === "item.started" || eventType === "item.completed" || eventType === "item.updated") {
        const item = decoded.item;

        if (!isRecord(item)) {
          continue;
        }

        const itemType = readString(item, "type");

        if (isToolItemType(itemType)) {
          const toolName = extractToolName(item);

          if (toolName !== undefined && toolName.length > 0) {
            events.push({
              type: "tool_call",
              toolName,
            });
          }
        }

        if (eventType === "item.completed" && isAssistantItemType(itemType)) {
          const itemText = extractItemText(item);

          if (itemText !== undefined) {
            responseText = itemText;
          }
        }

        continue;
      }

      if (eventType === "turn.completed") {
        if (terminalSeen) {
          return yield* Effect.fail(
            new CodexCodecError({
              message: "Duplicate terminal events are not allowed.",
            }),
          );
        }

        terminalSeen = true;
        stopReason = "completed";
        continue;
      }

      if (eventType === "turn.failed") {
        if (terminalSeen) {
          return yield* Effect.fail(
            new CodexCodecError({
              message: "Duplicate terminal events are not allowed.",
            }),
          );
        }

        terminalSeen = true;
        exitCode = 1;
        errorMessage = readString(decoded, "message") ?? "codex turn failed";
        stopReason = "failed";
        continue;
      }

      if (eventType === "error") {
        if (terminalSeen) {
          return yield* Effect.fail(
            new CodexCodecError({
              message: "Duplicate terminal events are not allowed.",
            }),
          );
        }

        terminalSeen = true;
        exitCode = 1;
        errorMessage = readString(decoded, "message") ?? "codex error";
        stopReason = "error";
      }
    }

    if (!terminalSeen) {
      return yield* Effect.fail(
        new CodexCodecError({
          message: "Missing terminal event from codex process output.",
        }),
      );
    }

    return {
      events,
      result: {
        text: responseText ?? "",
        sessionRef: sessionRef ?? `session/${input.spawnId}`,
        agent: input.agent,
        model: input.model,
        driver: "codex",
        exitCode,
        stopReason,
        errorMessage,
      },
    } satisfies DriverSpawnOutput;
  });
