import { Effect } from "effect";
import {
  getCurrentProgramContext,
  programContextUnavailable,
  type ProgramMill,
} from "./program-context.adapter";
import { createTaskActorFromEffect } from "./task-actor.api";
import { claude, codex, pi } from "./task.api";
import type { TaskActor, TaskInput } from "./types";

const makeUnavailableTaskActor = (input: TaskInput): TaskActor => {
  const error = programContextUnavailable();
  return createTaskActorFromEffect(input, {
    execute: () => Effect.fail(error),
    runId: "program-unavailable",
    taskId: "task-unavailable",
  }).start();
};

export const currentMill = (): ProgramMill => {
  const context = getCurrentProgramContext();

  if (context !== undefined) {
    return context.mill;
  }

  return {
    task: makeUnavailableTaskActor,
  };
};

export const task = (input: TaskInput): TaskActor => currentMill().task(input);

export const mill = new Proxy(
  {},
  {
    get: (_target, property) => {
      const current = currentMill() as unknown as Readonly<Record<PropertyKey, unknown>>;
      return current[property];
    },
  },
) as ProgramMill;

export { claude, codex, pi };
export type { AgentProvider, TaskActor, TaskCommand, TaskInput, TaskResult } from "./types";
