import { AsyncLocalStorage } from "node:async_hooks";
import { Data } from "effect";
import type { TaskActor, TaskInput, TaskResult } from "./types";

export class ProgramContextUnavailableError extends Data.TaggedError(
  "ProgramContextUnavailableError",
)<{
  readonly message: string;
}> {}

export type ProgramMill = {
  readonly task: (input: TaskInput) => TaskActor;
};

export type ProgramContext = {
  readonly mill: ProgramMill;
  readonly task: (input: TaskInput) => TaskActor;
  readonly completedTasks: () => ReadonlyArray<TaskResult>;
};

type MakeProgramContextInput = {
  readonly task: (input: TaskInput) => TaskActor;
  readonly completedTasks: () => ReadonlyArray<TaskResult>;
};

const storage = new AsyncLocalStorage<ProgramContext>();

export const makeProgramContext = (input: MakeProgramContextInput): ProgramContext => ({
  mill: { task: input.task },
  task: input.task,
  completedTasks: input.completedTasks,
});

export const withProgramContextPromise = <A>(
  context: ProgramContext,
  evaluate: () => Promise<A>,
): Promise<A> => storage.run(context, evaluate);

export const getCurrentProgramContext = (): ProgramContext | undefined => storage.getStore();

export const programContextUnavailable = (): ProgramContextUnavailableError =>
  new ProgramContextUnavailableError({
    message: "@mill/core/program task() was called outside a mill program host.",
  });
