import * as Schema from "effect/Schema";
import { SpawnResult } from "./spawn.schema";

export const SchemaVersion = Schema.Literal(1);
export type SchemaVersion = Schema.Schema.Type<typeof SchemaVersion>;

export const RunId = Schema.String.pipe(Schema.brand("RunId"));
export type RunId = Schema.Schema.Type<typeof RunId>;

export const SpawnId = Schema.String.pipe(Schema.brand("SpawnId"));
export type SpawnId = Schema.Schema.Type<typeof SpawnId>;

export const RunStatus = Schema.Literals(["pending", "running", "complete", "failed", "cancelled"]);
export type RunStatus = Schema.Schema.Type<typeof RunStatus>;

export const RunTerminalStatus = Schema.Literals(["complete", "failed", "cancelled"]);
export type RunTerminalStatus = Schema.Schema.Type<typeof RunTerminalStatus>;

export const RunPaths = Schema.Struct({
  runDir: Schema.NonEmptyString,
  runFile: Schema.NonEmptyString,
  eventsFile: Schema.NonEmptyString,
  resultFile: Schema.NonEmptyString,
});
export type RunPaths = Schema.Schema.Type<typeof RunPaths>;

export const RunMetadata = Schema.Record(Schema.String, Schema.String);
export type RunMetadata = Schema.Schema.Type<typeof RunMetadata>;

export const RunRecord = Schema.Struct({
  id: RunId,
  status: RunStatus,
  programPath: Schema.NonEmptyString,
  driver: Schema.NonEmptyString,
  executor: Schema.NonEmptyString,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  metadata: Schema.optional(RunMetadata),
  paths: RunPaths,
});
export type RunRecord = Schema.Schema.Type<typeof RunRecord>;

export const RunResult = Schema.Struct({
  runId: RunId,
  status: RunTerminalStatus,
  startedAt: Schema.String,
  completedAt: Schema.String,
  spawns: Schema.Array(SpawnResult),
  programResult: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
});
export type RunResult = Schema.Schema.Type<typeof RunResult>;

export const RunSyncOutput = Schema.Struct({
  run: RunRecord,
  result: RunResult,
});
export type RunSyncOutput = Schema.Schema.Type<typeof RunSyncOutput>;

export const RunRecordJson = Schema.fromJsonString(RunRecord);
export const RunResultJson = Schema.fromJsonString(RunResult);
export const RunSyncOutputJson = Schema.fromJsonString(RunSyncOutput);

export const decodeRunId = Schema.decodeUnknownEffect(RunId);
export const decodeRunIdSync = Schema.decodeUnknownSync(RunId);
export const decodeSpawnId = Schema.decodeUnknownEffect(SpawnId);
export const decodeSpawnIdSync = Schema.decodeUnknownSync(SpawnId);
export const decodeRunRecordJson = Schema.decodeUnknownEffect(RunRecordJson);
export const decodeRunRecordJsonSync = Schema.decodeUnknownSync(RunRecordJson);
export const decodeRunResultJson = Schema.decodeUnknownEffect(RunResultJson);
export const decodeRunResultJsonSync = Schema.decodeUnknownSync(RunResultJson);
export const decodeRunSyncOutputJson = Schema.decodeUnknownEffect(RunSyncOutputJson);
export const decodeRunSyncOutputJsonSync = Schema.decodeUnknownSync(RunSyncOutputJson);
