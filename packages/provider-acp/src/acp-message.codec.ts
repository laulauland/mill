import { Effect } from "effect";
import * as Schema from "effect/Schema";
import type { AcpMessage } from "./AcpSession";

const AcpWireMessage = Schema.Struct({
  type: Schema.optional(
    Schema.Union([
      Schema.Literal("text"),
      Schema.Literal("tool_call"),
      Schema.Literal("tool_result"),
      Schema.Literal("error"),
    ]),
  ),
  content: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

export const decodeAcpMessage = (line: string): Effect.Effect<AcpMessage> =>
  Effect.try({
    try: () => {
      const value = Schema.decodeUnknownSync(AcpWireMessage)(JSON.parse(line));
      return {
        type: value.type ?? "text",
        content: value.content ?? line,
        metadata: value.metadata,
      };
    },
    catch: (error) => error,
  }).pipe(Effect.catch(() => Effect.succeed({ type: "text" as const, content: line })));
