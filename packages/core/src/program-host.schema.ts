import * as Schema from "effect/Schema";
import { SpawnOptions } from "./spawn.schema";

export const ProgramHostProtocolPrefix = "__MILL_HOST__";

const RequestId = Schema.NonEmptyString;

const AgentProvider = Schema.Struct({
  driver: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  displayName: Schema.optional(Schema.String),
});

const SteeringPolicy = Schema.Literal("queue", "interrupt", "reject");

export const ProgramHostTaskOptions = Schema.Struct({
  agent: AgentProvider,
  prompt: Schema.NonEmptyString,
  system: Schema.optional(Schema.NonEmptyString),
  role: Schema.optional(Schema.NonEmptyString),
  steering: Schema.optional(SteeringPolicy),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export type ProgramHostTaskOptions = Schema.Schema.Type<typeof ProgramHostTaskOptions>;

export const ProgramHostSpawnRequestMessage = Schema.Struct({
  kind: Schema.Literal("request"),
  requestId: RequestId,
  requestType: Schema.Literal("spawn"),
  input: SpawnOptions,
});

export const ProgramHostTaskRequestMessage = Schema.Struct({
  kind: Schema.Literal("request"),
  requestId: RequestId,
  requestType: Schema.Literal("task"),
  input: ProgramHostTaskOptions,
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
  value: Schema.optional(Schema.Unknown),
});

export const ProgramHostFailureResultMessage = Schema.Struct({
  kind: Schema.Literal("result"),
  ok: Schema.Literal(false),
  message: Schema.String,
});

export const ProgramHostInboundMessage = Schema.Union([
  ProgramHostSpawnRequestMessage,
  ProgramHostTaskRequestMessage,
  ProgramHostExtensionRequestMessage,
  ProgramHostSuccessResultMessage,
  ProgramHostFailureResultMessage,
]);

export type ProgramHostInboundMessage = Schema.Schema.Type<typeof ProgramHostInboundMessage>;

const ProgramHostInboundMessageJson = Schema.fromJsonString(ProgramHostInboundMessage);

export const decodeProgramHostInboundMessage = Schema.decodeUnknownEffect(
  ProgramHostInboundMessageJson,
);

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

export const ProgramHostResponseMessage = Schema.Union([
  ProgramHostSuccessResponseMessage,
  ProgramHostFailureResponseMessage,
]);

export type ProgramHostResponseMessage = Schema.Schema.Type<typeof ProgramHostResponseMessage>;
