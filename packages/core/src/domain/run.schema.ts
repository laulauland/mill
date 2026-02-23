import * as Schema from "@effect/schema/Schema";

export const RunId = Schema.String.pipe(Schema.brand("RunId"));
export type RunId = Schema.Schema.Type<typeof RunId>;

export const SpawnId = Schema.String.pipe(Schema.brand("SpawnId"));
export type SpawnId = Schema.Schema.Type<typeof SpawnId>;

export const RunStatus = Schema.Literal("pending", "running", "complete", "failed", "cancelled");
export type RunStatus = Schema.Schema.Type<typeof RunStatus>;

export const RunRecord = Schema.Struct({
  id: RunId,
  status: RunStatus,
});
export type RunRecord = Schema.Schema.Type<typeof RunRecord>;
