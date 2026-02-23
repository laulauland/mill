import * as Schema from "@effect/schema/Schema";
import { Data, Effect } from "effect";
import type { DriverSpawnEvent, DriverSpawnOutput } from "@mill/core";

export class PiCodecError extends Data.TaggedError("PiCodecError")<{
  message: string;
}> {}

const PiMilestoneLine = Schema.Struct({
  type: Schema.Literal("milestone"),
  message: Schema.NonEmptyString,
});

type PiMilestoneLine = Schema.Schema.Type<typeof PiMilestoneLine>;

const PiToolCallLine = Schema.Struct({
  type: Schema.Literal("tool_call"),
  toolName: Schema.NonEmptyString,
});

type PiToolCallLine = Schema.Schema.Type<typeof PiToolCallLine>;

const PiFinalLine = Schema.Struct({
  type: Schema.Literal("final"),
  text: Schema.String,
  sessionRef: Schema.NonEmptyString,
  agent: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  exitCode: Schema.Number,
  stopReason: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
});

type PiFinalLine = Schema.Schema.Type<typeof PiFinalLine>;

const PiOutputLine = Schema.Union(PiMilestoneLine, PiToolCallLine, PiFinalLine);

const decodeLine = Schema.decodeUnknown(Schema.parseJson(PiOutputLine));

const toDriverEvent = (line: PiMilestoneLine | PiToolCallLine): DriverSpawnEvent => {
  if (line.type === "milestone") {
    return {
      type: "milestone",
      message: line.message,
    };
  }

  return {
    type: "tool_call",
    toolName: line.toolName,
  };
};

const decodeFinalResult = (
  finalLine: PiFinalLine | undefined,
): Effect.Effect<DriverSpawnOutput["result"], PiCodecError> => {
  if (finalLine === undefined) {
    return Effect.fail(
      new PiCodecError({
        message: "Missing final output line from pi process",
      }),
    );
  }

  return Effect.succeed({
    text: finalLine.text,
    sessionRef: finalLine.sessionRef,
    agent: finalLine.agent,
    model: finalLine.model,
    driver: "pi",
    exitCode: finalLine.exitCode,
    stopReason: finalLine.stopReason,
    errorMessage: finalLine.errorMessage,
  });
};

export const decodePiProcessOutput = (
  output: string,
): Effect.Effect<DriverSpawnOutput, PiCodecError> =>
  Effect.gen(function* () {
    const lines = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const decodedLines = yield* Effect.forEach(lines, (line) =>
      Effect.mapError(
        decodeLine(line),
        (error) =>
          new PiCodecError({
            message: String(error),
          }),
      ),
    );

    let finalLine: PiFinalLine | undefined = undefined;
    const events: Array<DriverSpawnEvent> = [];

    for (const decoded of decodedLines) {
      if (decoded.type === "final") {
        if (finalLine !== undefined) {
          return yield* Effect.fail(
            new PiCodecError({
              message: "Duplicate terminal final lines are not allowed.",
            }),
          );
        }

        finalLine = decoded;
        continue;
      }

      if (finalLine !== undefined) {
        return yield* Effect.fail(
          new PiCodecError({
            message: `Non-terminal line ${decoded.type} emitted after final terminal line.`,
          }),
        );
      }

      events.push(toDriverEvent(decoded));
    }

    const result = yield* decodeFinalResult(finalLine);

    return {
      events,
      result,
    } satisfies DriverSpawnOutput;
  });
