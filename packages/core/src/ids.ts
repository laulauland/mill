import { Effect } from "effect";

let nextId = 0;

export const generateTaskId = (): string => {
  nextId += 1;
  return `task_${Date.now()}_${nextId}`;
};

export const generateTaskIdEffect = (): Effect.Effect<string> =>
  Effect.sync(generateTaskId);
