import * as Schema from "@effect/schema/Schema";
import {
  RunId,
  RunResult,
  RunStatus,
  SchemaVersion,
  SpawnId,
  type RunId as RunIdType,
} from "./run.schema";
import { SpawnOptions, SpawnResult } from "./spawn.schema";

const EventEnvelope = {
  schemaVersion: SchemaVersion,
  runId: RunId,
  sequence: Schema.Int,
  timestamp: Schema.String,
} as const;

export const RunStartEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("run:start"),
  payload: Schema.Struct({
    programPath: Schema.NonEmptyString,
  }),
});
export type RunStartEvent = Schema.Schema.Type<typeof RunStartEvent>;

export const RunStatusEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("run:status"),
  payload: Schema.Struct({
    status: RunStatus,
  }),
});
export type RunStatusEvent = Schema.Schema.Type<typeof RunStatusEvent>;

export const RunCompleteEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("run:complete"),
  payload: Schema.Struct({
    result: RunResult,
  }),
});
export type RunCompleteEvent = Schema.Schema.Type<typeof RunCompleteEvent>;

export const RunFailedEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("run:failed"),
  payload: Schema.Struct({
    message: Schema.String,
  }),
});
export type RunFailedEvent = Schema.Schema.Type<typeof RunFailedEvent>;

export const RunCancelledEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("run:cancelled"),
  payload: Schema.Struct({
    reason: Schema.optional(Schema.String),
  }),
});
export type RunCancelledEvent = Schema.Schema.Type<typeof RunCancelledEvent>;

export const SpawnStartEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("spawn:start"),
  payload: Schema.Struct({
    spawnId: SpawnId,
    input: SpawnOptions,
  }),
});
export type SpawnStartEvent = Schema.Schema.Type<typeof SpawnStartEvent>;

export const SpawnMilestoneEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("spawn:milestone"),
  payload: Schema.Struct({
    spawnId: SpawnId,
    message: Schema.NonEmptyString,
  }),
});
export type SpawnMilestoneEvent = Schema.Schema.Type<typeof SpawnMilestoneEvent>;

export const SpawnToolCallEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("spawn:tool_call"),
  payload: Schema.Struct({
    spawnId: SpawnId,
    toolName: Schema.NonEmptyString,
  }),
});
export type SpawnToolCallEvent = Schema.Schema.Type<typeof SpawnToolCallEvent>;

export const SpawnErrorEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("spawn:error"),
  payload: Schema.Struct({
    spawnId: SpawnId,
    message: Schema.String,
  }),
});
export type SpawnErrorEvent = Schema.Schema.Type<typeof SpawnErrorEvent>;

export const SpawnCompleteEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("spawn:complete"),
  payload: Schema.Struct({
    spawnId: SpawnId,
    result: SpawnResult,
  }),
});
export type SpawnCompleteEvent = Schema.Schema.Type<typeof SpawnCompleteEvent>;

export const SpawnCancelledEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("spawn:cancelled"),
  payload: Schema.Struct({
    spawnId: SpawnId,
    reason: Schema.optional(Schema.String),
  }),
});
export type SpawnCancelledEvent = Schema.Schema.Type<typeof SpawnCancelledEvent>;

export const ExtensionErrorEvent = Schema.Struct({
  ...EventEnvelope,
  type: Schema.Literal("extension:error"),
  payload: Schema.Struct({
    extensionName: Schema.NonEmptyString,
    hook: Schema.Literal("setup", "onEvent"),
    message: Schema.String,
  }),
});
export type ExtensionErrorEvent = Schema.Schema.Type<typeof ExtensionErrorEvent>;

export const MillEvent = Schema.Union(
  RunStartEvent,
  RunStatusEvent,
  RunCompleteEvent,
  RunFailedEvent,
  RunCancelledEvent,
  SpawnStartEvent,
  SpawnMilestoneEvent,
  SpawnToolCallEvent,
  SpawnErrorEvent,
  SpawnCompleteEvent,
  SpawnCancelledEvent,
  ExtensionErrorEvent,
);
export type MillEvent = Schema.Schema.Type<typeof MillEvent>;

export const MillEventJson = Schema.parseJson(MillEvent);

export const decodeMillEventJson = Schema.decodeUnknown(MillEventJson);
export const decodeMillEventJsonSync = Schema.decodeUnknownSync(MillEventJson);

export const encodeMillEventJson = (event: MillEvent): string => JSON.stringify(event);

export const makeEventEnvelope = (
  runId: RunIdType,
  sequence: number,
  timestamp: string,
): Pick<MillEvent, "schemaVersion" | "runId" | "sequence" | "timestamp"> => ({
  schemaVersion: 1,
  runId,
  sequence,
  timestamp,
});
