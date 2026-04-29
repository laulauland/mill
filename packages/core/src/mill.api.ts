import { Effect } from "effect";
import { createRunActor, createTaskActor } from "./task-actor.api";
import { spawnOutputToTaskResult, taskInputToSpawnInput } from "./task.api";
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

const runTask = async (input: TaskInput): Promise<TaskResult> =>
  spawnOutputToTaskResult(await runSpawn(taskInputToSpawnInput(input)));

export const createMill = (): Promise<Mill> =>
  Effect.runPromise(
    Effect.succeed({
      spawn: runSpawn,
      task: runTask,
      taskActor: (input: TaskInput) => createTaskActor(input, { execute: runTask }),
      runActor: () => createRunActor(),
    }),
  );
