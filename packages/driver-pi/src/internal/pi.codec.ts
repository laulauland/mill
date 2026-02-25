import { Data, Effect } from "effect";
import type { DriverSpawnEvent, DriverSpawnOutput } from "@mill/core";

export class PiCodecError extends Data.TaggedError("PiCodecError")<{
  message: string;
}> {}

type DecodePiProcessInput = {
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

const extractTextFromContent = (content: unknown): string | undefined => {
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

const extractAssistantSummary = (
  message: unknown,
): { text?: string; stopReason?: string; errorMessage?: string } => {
  if (!isRecord(message)) {
    return {};
  }

  return {
    text: extractTextFromContent(message.content),
    stopReason: readString(message, "stopReason"),
    errorMessage: readString(message, "errorMessage"),
  };
};

const decodeJsonLine = (line: string): Effect.Effect<JsonRecord, PiCodecError> =>
  Effect.flatMap(
    Effect.try({
      try: () => JSON.parse(line) as unknown,
      catch: (error) =>
        new PiCodecError({
          message: String(error),
        }),
    }),
    (parsed) =>
      isRecord(parsed)
        ? Effect.succeed(parsed)
        : Effect.fail(
            new PiCodecError({
              message: "line must decode to a JSON object",
            }),
          ),
  );

export const decodePiProcessOutput = (
  output: string,
  input: DecodePiProcessInput,
): Effect.Effect<DriverSpawnOutput, PiCodecError> =>
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
    let errorMessage: string | undefined;
    let terminalSeen = false;

    for (const decoded of decodedLines) {
      const eventType = readString(decoded, "type");

      if (eventType === "agent_end") {
        terminalSeen = true;

        const messages = decoded.messages;

        if (Array.isArray(messages)) {
          const assistantMessages = messages
            .filter((entry): entry is JsonRecord => isRecord(entry))
            .filter((entry) => readString(entry, "role") === "assistant");

          const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
          const assistantSummary = extractAssistantSummary(lastAssistantMessage);

          if (assistantSummary.text !== undefined) {
            responseText = assistantSummary.text;
          }

          if (assistantSummary.stopReason !== undefined) {
            stopReason = assistantSummary.stopReason;
          }

          if (assistantSummary.errorMessage !== undefined) {
            errorMessage = assistantSummary.errorMessage;
          }
        }

        continue;
      }

      if (eventType === "session") {
        const id = readString(decoded, "id");

        if (id !== undefined) {
          sessionRef = id;
          events.push({
            type: "milestone",
            message: "session:start",
          });
        }

        continue;
      }

      if (eventType === "agent_start") {
        events.push({
          type: "milestone",
          message: "agent:start",
        });
        continue;
      }

      if (eventType === "turn_start") {
        events.push({
          type: "milestone",
          message: "turn:start",
        });
        continue;
      }

      if (eventType === "tool_execution_start") {
        const toolName = readString(decoded, "toolName");

        if (toolName !== undefined) {
          events.push({
            type: "tool_call",
            toolName,
          });
        }

        continue;
      }

      if (eventType === "message_end") {
        const message = decoded.message;

        if (!isRecord(message) || readString(message, "role") !== "assistant") {
          continue;
        }

        const assistantSummary = extractAssistantSummary(message);

        if (assistantSummary.text !== undefined) {
          responseText = assistantSummary.text;
        }

        if (assistantSummary.stopReason !== undefined) {
          stopReason = assistantSummary.stopReason;
        }

        if (assistantSummary.errorMessage !== undefined) {
          errorMessage = assistantSummary.errorMessage;
        }
      }
    }

    if (!terminalSeen) {
      return yield* Effect.fail(
        new PiCodecError({
          message: "Missing terminal agent_end line from pi process output.",
        }),
      );
    }

    const exitCode = stopReason === "error" || errorMessage !== undefined ? 1 : 0;

    return {
      events,
      result: {
        text: responseText ?? "",
        sessionRef: sessionRef ?? `session/${input.spawnId}`,
        agent: input.agent,
        model: input.model,
        driver: "pi",
        exitCode,
        stopReason,
        errorMessage,
      },
    } satisfies DriverSpawnOutput;
  });

export const decodePiModelCatalogOutput = (
  output: string,
): Effect.Effect<ReadonlyArray<string>, PiCodecError> =>
  Effect.gen(function* () {
    const lines = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const models = new Set<string>();

    for (const line of lines) {
      if (line.startsWith("provider") || line.startsWith("-")) {
        continue;
      }

      const match = /^(\S+)\s+(\S+)\s+/.exec(line);

      if (match === null) {
        continue;
      }

      const provider = match[1];
      const model = match[2];

      if (provider !== undefined && model !== undefined) {
        models.add(`${provider}/${model}`);
      }
    }

    if (models.size === 0) {
      return yield* Effect.fail(
        new PiCodecError({
          message: "No models found in pi --list-models output.",
        }),
      );
    }

    return Array.from(models);
  });
