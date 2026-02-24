import { Data, Effect } from "effect";
import type { DriverSpawnEvent, DriverSpawnOutput } from "@mill/core";

export class ClaudeCodecError extends Data.TaggedError("ClaudeCodecError")<{
  message: string;
}> {}

type DecodeClaudeProcessInput = {
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

const decodeJsonLine = (line: string): Effect.Effect<JsonRecord, ClaudeCodecError> =>
  Effect.flatMap(
    Effect.try({
      try: () => JSON.parse(line) as unknown,
      catch: (error) =>
        new ClaudeCodecError({
          message: String(error),
        }),
    }),
    (parsed) =>
      isRecord(parsed)
        ? Effect.succeed(parsed)
        : Effect.fail(
            new ClaudeCodecError({
              message: "line must decode to a JSON object",
            }),
          ),
  );

const extractAssistantText = (message: JsonRecord): string | undefined => {
  const content = message.content;

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
    .filter((text): text is string => text !== undefined && text.length > 0);

  if (textParts.length === 0) {
    return undefined;
  }

  return textParts.join("\n");
};

export const decodeClaudeProcessOutput = (
  output: string,
  input: DecodeClaudeProcessInput,
): Effect.Effect<DriverSpawnOutput, ClaudeCodecError> =>
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

      if (terminalSeen && eventType !== "result") {
        return yield* Effect.fail(
          new ClaudeCodecError({
            message: `Non-terminal line ${eventType ?? "unknown"} emitted after terminal result.`,
          }),
        );
      }

      if (eventType === "system") {
        const currentSessionRef = readString(decoded, "session_id");

        if (currentSessionRef !== undefined) {
          sessionRef = currentSessionRef;
          events.push({
            type: "milestone",
            message: "session:start",
          });
        }

        continue;
      }

      if (eventType === "assistant") {
        const message = decoded.message;

        if (!isRecord(message)) {
          continue;
        }

        const content = message.content;

        if (Array.isArray(content)) {
          for (const entry of content) {
            if (!isRecord(entry)) {
              continue;
            }

            if (readString(entry, "type") !== "tool_use") {
              continue;
            }

            const toolName = readString(entry, "name");

            if (toolName === undefined) {
              continue;
            }

            events.push({
              type: "tool_call",
              toolName,
            });
          }
        }

        const assistantText = extractAssistantText(message);

        if (assistantText !== undefined) {
          responseText = assistantText;
        }

        continue;
      }

      if (eventType === "result") {
        if (terminalSeen) {
          return yield* Effect.fail(
            new ClaudeCodecError({
              message: "Duplicate terminal result lines are not allowed.",
            }),
          );
        }

        terminalSeen = true;

        const resultText = readString(decoded, "result");

        if (resultText !== undefined) {
          responseText = resultText;
        }

        const resultSessionRef = readString(decoded, "session_id");

        if (resultSessionRef !== undefined) {
          sessionRef = resultSessionRef;
        }

        stopReason = readString(decoded, "stop_reason");

        if (decoded.is_error === true) {
          exitCode = 1;
          errorMessage = resultText ?? "claude command failed";
        }
      }
    }

    if (!terminalSeen) {
      return yield* Effect.fail(
        new ClaudeCodecError({
          message: "Missing terminal result line from claude process output.",
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
        driver: "claude",
        exitCode,
        stopReason,
        errorMessage,
      },
    } satisfies DriverSpawnOutput;
  });
