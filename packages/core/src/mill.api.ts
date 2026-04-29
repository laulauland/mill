import { Effect } from "effect";
import type { Mill, SpawnInput, SpawnOutput } from "./types";

const buildSpawnOutput = (input: SpawnInput): SpawnOutput => ({
  text: `noop response for ${input.agent}`,
  sessionRef: "session/noop",
  agent: input.agent,
  model: input.model,
  driver: "default",
  exitCode: 0,
});

export const createMill = (): Promise<Mill> =>
  Effect.runPromise(
    Effect.succeed({
      spawn: (input: SpawnInput) => Effect.runPromise(Effect.succeed(buildSpawnOutput(input))),
    }),
  );
