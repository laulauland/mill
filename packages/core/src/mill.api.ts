import { Effect } from "effect";
import { createRunActor, createTaskActor } from "./task-actor.api";
import type { Mill, SpawnInput, SpawnOutput, TaskInput, TaskResult } from "./types";

const buildSpawnOutput = (input: SpawnInput): SpawnOutput => ({
  text: `noop response for ${input.agent}`,
  sessionRef: "session/noop",
  agent: input.agent,
  model: input.model,
  driver: "default",
  exitCode: 0,
});

const runSpawn = (input: SpawnInput): Promise<SpawnOutput> =>
  Effect.runPromise(Effect.succeed(buildSpawnOutput(input)));

const runTask = async (input: TaskInput): Promise<TaskResult> => ({
  text: `noop response for ${input.role ?? input.agent.driver}`,
  sessionRef: "session/noop",
  role: input.role ?? input.agent.driver,
  model: input.agent.model,
  driver: input.agent.driver,
  exitCode: 0,
});

export const createMill = (): Promise<Mill> =>
  Effect.runPromise(
    Effect.succeed({
      spawn: runSpawn,
      task: runTask,
      taskActor: (input: TaskInput) => createTaskActor(input, { execute: runTask }),
      runActor: () => createRunActor(),
    }),
  );
