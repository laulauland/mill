import { Effect } from "effect";
import type { RunId } from "../domain/run.schema";
import type { SpawnOptions, SpawnResult } from "../domain/spawn.schema";
import type { MillEngine } from "../internal/engine.effect";

export interface WorkerInput {
  readonly engine: MillEngine;
  readonly runId: RunId;
  readonly programPath: string;
  readonly spawn: SpawnOptions;
}

export const runWorker = (input: WorkerInput): Effect.Effect<SpawnResult> =>
  Effect.flatMap(
    input.engine.runSync({
      runId: input.runId,
      programPath: input.programPath,
      executeProgram: (spawn) => Effect.flatMap(spawn(input.spawn), () => Effect.void),
    }),
    (output) =>
      Effect.succeed(
        output.result.spawns[0] ?? {
          text: "",
          sessionRef: "session/worker-missing",
          agent: input.spawn.agent,
          model: input.spawn.model ?? "unknown",
          driver: "unknown",
          exitCode: 1,
          errorMessage: "no spawn result",
        },
      ),
  );
