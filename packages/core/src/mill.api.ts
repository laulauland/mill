import { Effect } from "effect";
import { createRunActor, createTaskActor } from "./task-actor.api";
import type { Mill, TaskInput, TaskResult } from "./types";

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
      task: runTask,
      taskActor: (input: TaskInput) => createTaskActor(input, { execute: runTask }),
      runActor: () => createRunActor(),
    }),
  );
