import * as Schema from "effect/Schema";

export const ProgramHostProtocolPrefix = "__MILL_HOST__";

const RequestId = Schema.NonEmptyString;
const TaskId = Schema.NonEmptyString;

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

export const ProgramHostTaskCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("message"),
    content: Schema.String,
    mode: Schema.optional(SteeringPolicy),
  }),
  Schema.Struct({
    type: Schema.Literal("context"),
    content: Schema.String,
    from: Schema.optional(
      Schema.Union([Schema.String, Schema.Struct({ runId: Schema.String, taskId: Schema.String })]),
    ),
    mode: Schema.optional(SteeringPolicy),
  }),
  Schema.Struct({
    type: Schema.Literal("cancel"),
    reason: Schema.optional(Schema.String),
  }),
]);

export type ProgramHostTaskCommand = Schema.Schema.Type<typeof ProgramHostTaskCommand>;

export const ProgramHostTaskCreateRequestMessage = Schema.Struct({
  kind: Schema.Literal("request"),
  requestId: RequestId,
  requestType: Schema.Literal("task:create"),
  taskId: TaskId,
  input: ProgramHostTaskOptions,
});

export const ProgramHostTaskStartRequestMessage = Schema.Struct({
  kind: Schema.Literal("request"),
  requestId: RequestId,
  requestType: Schema.Literal("task:start"),
  taskId: TaskId,
});

export const ProgramHostTaskSendRequestMessage = Schema.Struct({
  kind: Schema.Literal("request"),
  requestId: RequestId,
  requestType: Schema.Literal("task:send"),
  taskId: TaskId,
  command: ProgramHostTaskCommand,
});

export const ProgramHostTaskCancelRequestMessage = Schema.Struct({
  kind: Schema.Literal("request"),
  requestId: RequestId,
  requestType: Schema.Literal("task:cancel"),
  taskId: TaskId,
  reason: Schema.optional(Schema.String),
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
  ProgramHostTaskCreateRequestMessage,
  ProgramHostTaskStartRequestMessage,
  ProgramHostTaskSendRequestMessage,
  ProgramHostTaskCancelRequestMessage,
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

export const ProgramHostTaskSnapshotMessage = Schema.Struct({
  kind: Schema.Literal("task:snapshot"),
  taskId: TaskId,
  snapshot: Schema.Unknown,
});

export const ProgramHostTaskDoneMessage = Schema.Struct({
  kind: Schema.Literal("task:done"),
  taskId: TaskId,
  result: Schema.Unknown,
});

export const ProgramHostTaskErrorMessage = Schema.Struct({
  kind: Schema.Literal("task:error"),
  taskId: TaskId,
  message: Schema.String,
});

export const ProgramHostResponseMessage = Schema.Union([
  ProgramHostSuccessResponseMessage,
  ProgramHostFailureResponseMessage,
]);

export const ProgramHostOutboundMessage = Schema.Union([
  ProgramHostSuccessResponseMessage,
  ProgramHostFailureResponseMessage,
  ProgramHostTaskSnapshotMessage,
  ProgramHostTaskDoneMessage,
  ProgramHostTaskErrorMessage,
]);

export type ProgramHostResponseMessage = Schema.Schema.Type<typeof ProgramHostResponseMessage>;
export type ProgramHostOutboundMessage = Schema.Schema.Type<typeof ProgramHostOutboundMessage>;
