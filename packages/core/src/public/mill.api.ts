import { Effect, Runtime } from "effect";
import type { Mill, SpawnInput, SpawnOutput } from "./types";

const runtime = Runtime.defaultRuntime;

const buildSpawnOutput = (input: SpawnInput): SpawnOutput => ({
  text: `noop response for ${input.agent}`,
  sessionRef: "session/noop",
  agent: input.agent,
  model: input.model ?? "openai/gpt-5.3-codex",
  driver: "default",
  exitCode: 0,
});

export const createMill = (): Promise<Mill> =>
  Runtime.runPromise(runtime)(
    Effect.succeed({
      spawn: (input: SpawnInput) =>
        Runtime.runPromise(runtime)(Effect.succeed(buildSpawnOutput(input))),
    }),
  );
