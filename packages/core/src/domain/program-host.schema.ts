import * as Schema from "@effect/schema/Schema";
import { SpawnOptions } from "./spawn.schema";

export const ProgramHostProtocolPrefix = "__MILL_HOST__";

const RequestId = Schema.NonEmptyString;

export const ProgramHostSpawnRequestMessage = Schema.Struct({
  kind: Schema.Literal("request"),
  requestId: RequestId,
  requestType: Schema.Literal("spawn"),
  input: SpawnOptions,
});

export const ProgramHostExtensionRequestMessage = Schema.Struct({
  kind: Schema.Literal("request"),
  requestId: RequestId,
  requestType: Schema.Literal("extension"),
  extensionName: Schema.NonEmptyString,
  methodName: Schema.NonEmptyString,
  args: Schema.Array(Schema.Unknown),
});

export const ProgramHostSuccessResultMessage = Schema.Struct({
  kind: Schema.Literal("result"),
  ok: Schema.Literal(true),
  value: Schema.Unknown,
});

export const ProgramHostFailureResultMessage = Schema.Struct({
  kind: Schema.Literal("result"),
  ok: Schema.Literal(false),
  message: Schema.String,
});

export const ProgramHostInboundMessage = Schema.Union(
  ProgramHostSpawnRequestMessage,
  ProgramHostExtensionRequestMessage,
  ProgramHostSuccessResultMessage,
  ProgramHostFailureResultMessage,
);

export type ProgramHostInboundMessage = Schema.Schema.Type<typeof ProgramHostInboundMessage>;

const ProgramHostInboundMessageJson = Schema.parseJson(ProgramHostInboundMessage);

export const decodeProgramHostInboundMessage = Schema.decodeUnknown(ProgramHostInboundMessageJson);

export const ProgramHostSuccessResponseMessage = Schema.Struct({
  kind: Schema.Literal("response"),
  requestId: RequestId,
  ok: Schema.Literal(true),
  value: Schema.Unknown,
});

export const ProgramHostFailureResponseMessage = Schema.Struct({
  kind: Schema.Literal("response"),
  requestId: RequestId,
  ok: Schema.Literal(false),
  message: Schema.String,
});

export const ProgramHostResponseMessage = Schema.Union(
  ProgramHostSuccessResponseMessage,
  ProgramHostFailureResponseMessage,
);

export type ProgramHostResponseMessage = Schema.Schema.Type<typeof ProgramHostResponseMessage>;
