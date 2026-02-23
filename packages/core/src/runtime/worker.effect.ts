import { Effect } from "effect";
import type { MillEngine } from "../internal/engine.effect";
import type { SpawnOptions, SpawnResult } from "../domain/spawn.schema";

export interface WorkerInput {
  readonly engine: MillEngine;
  readonly spawn: SpawnOptions;
}

export const runWorker = (input: WorkerInput): Effect.Effect<SpawnResult> =>
  input.engine.submit(input.spawn);
