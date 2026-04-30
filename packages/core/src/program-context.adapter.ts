import { AsyncLocalStorage } from "node:async_hooks";
import { Data, Effect } from "effect";
import type { ExtensionRegistration, TaskActor, TaskInput, TaskResult } from "./types";

export class ProgramContextUnavailableError extends Data.TaggedError(
  "ProgramContextUnavailableError",
)<{
  readonly message: string;
}> {}

export type ProgramMill = {
  readonly task: (input: TaskInput) => TaskActor;
  readonly [extensionName: string]: unknown;
};

export type ProgramContext = {
  readonly mill: ProgramMill;
  readonly task: (input: TaskInput) => TaskActor;
  readonly completedTasks: () => ReadonlyArray<TaskResult>;
};

type MakeProgramContextInput = {
  readonly task: (input: TaskInput) => TaskActor;
  readonly extensions: ReadonlyArray<ExtensionRegistration>;
  readonly completedTasks: () => ReadonlyArray<TaskResult>;
};

const storage = new AsyncLocalStorage<ProgramContext>();

const makeExtensionApi = (
  extension: ExtensionRegistration,
): Readonly<Record<string, (...args: ReadonlyArray<unknown>) => Promise<unknown>>> => {
  const api = extension.api ?? {};
  const entries = Object.entries(api).map(
    ([methodName, method]) =>
      [
        methodName,
        (...args: ReadonlyArray<unknown>) => Effect.runPromise(method(...args)),
      ] as const,
  );

  return Object.fromEntries(entries);
};

export const makeProgramContext = (input: MakeProgramContextInput): ProgramContext => {
  const extensionEntries = input.extensions
    .filter((extension) => extension.api !== undefined)
    .map((extension) => [extension.name, makeExtensionApi(extension)] as const);

  const mill = {
    task: input.task,
    ...Object.fromEntries(extensionEntries),
  } as ProgramMill;

  return {
    mill,
    task: input.task,
    completedTasks: input.completedTasks,
  };
};

export const withProgramContextPromise = <A>(
  context: ProgramContext,
  evaluate: () => Promise<A>,
): Promise<A> => storage.run(context, evaluate);

export const getCurrentProgramContext = (): ProgramContext | undefined => storage.getStore();

export const programContextUnavailable = (): ProgramContextUnavailableError =>
  new ProgramContextUnavailableError({
    message: "@mill/core/program task() was called outside a mill program host.",
  });
