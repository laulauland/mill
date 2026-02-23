import * as Schema from "@effect/schema/Schema";
import { SpawnResult } from "./spawn.schema";

export const SchemaVersion = Schema.Literal(1);
export type SchemaVersion = Schema.Schema.Type<typeof SchemaVersion>;

export const RunId = Schema.String.pipe(Schema.brand("RunId"));
export type RunId = Schema.Schema.Type<typeof RunId>;

export const SpawnId = Schema.String.pipe(Schema.brand("SpawnId"));
export type SpawnId = Schema.Schema.Type<typeof SpawnId>;

export const RunStatus = Schema.Literal("pending", "running", "complete", "failed", "cancelled");
export type RunStatus = Schema.Schema.Type<typeof RunStatus>;

export const RunTerminalStatus = Schema.Literal("complete", "failed", "cancelled");
export type RunTerminalStatus = Schema.Schema.Type<typeof RunTerminalStatus>;

export const RunPaths = Schema.Struct({
  runDir: Schema.NonEmptyString,
  runFile: Schema.NonEmptyString,
  eventsFile: Schema.NonEmptyString,
  resultFile: Schema.NonEmptyString,
});
export type RunPaths = Schema.Schema.Type<typeof RunPaths>;

export const RunRecord = Schema.Struct({
  id: RunId,
  status: RunStatus,
  programPath: Schema.NonEmptyString,
  driver: Schema.NonEmptyString,
  executor: Schema.NonEmptyString,
  createdAt: Schema.String,
  updatedAt: Schema.String,
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

export const RunRecordJson = Schema.parseJson(RunRecord);
export const RunResultJson = Schema.parseJson(RunResult);
export const RunSyncOutputJson = Schema.parseJson(RunSyncOutput);

export const decodeRunId = Schema.decodeUnknown(RunId);
export const decodeRunIdSync = Schema.decodeUnknownSync(RunId);
export const decodeSpawnId = Schema.decodeUnknown(SpawnId);
export const decodeSpawnIdSync = Schema.decodeUnknownSync(SpawnId);
export const decodeRunRecordJson = Schema.decodeUnknown(RunRecordJson);
export const decodeRunRecordJsonSync = Schema.decodeUnknownSync(RunRecordJson);
export const decodeRunResultJson = Schema.decodeUnknown(RunResultJson);
export const decodeRunResultJsonSync = Schema.decodeUnknownSync(RunResultJson);
export const decodeRunSyncOutputJson = Schema.decodeUnknown(RunSyncOutputJson);
export const decodeRunSyncOutputJsonSync = Schema.decodeUnknownSync(RunSyncOutputJson);
