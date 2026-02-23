import { Data, Effect } from "effect";
import type { ExecutorRegistration, ExecutorRuntime } from "../public/types";

export class ExecutorRegistryError extends Data.TaggedError("ExecutorRegistryError")<{
  requested: string;
  available: ReadonlyArray<string>;
  message: string;
}> {}

export interface ExecutorRegistry {
  readonly list: ReadonlyArray<string>;
  readonly resolve: (name: string | undefined) => Effect.Effect<
    {
      readonly name: string;
      readonly registration: ExecutorRegistration;
      readonly runtime: ExecutorRuntime;
    },
    ExecutorRegistryError
  >;
}

export interface MakeExecutorRegistryInput {
  readonly defaultExecutor: string;
  readonly executors: Readonly<Record<string, ExecutorRegistration>>;
}

const sortedExecutorNames = (
  executors: Readonly<Record<string, ExecutorRegistration>>,
): ReadonlyArray<string> => Object.keys(executors).sort((left, right) => left.localeCompare(right));

const missingExecutorError = (
  requested: string,
  available: ReadonlyArray<string>,
): ExecutorRegistryError =>
  new ExecutorRegistryError({
    requested,
    available,
    message: `Unknown executor '${requested}'. Available executors: ${available.join(", ")}.`,
  });

export const makeExecutorRegistry = (input: MakeExecutorRegistryInput): ExecutorRegistry => {
  const available = sortedExecutorNames(input.executors);

  return {
    list: available,
    resolve: (name) => {
      const requested = name ?? input.defaultExecutor;
      const registration = input.executors[requested];

      if (registration === undefined) {
        return Effect.fail(missingExecutorError(requested, available));
      }

      return Effect.succeed({
        name: requested,
        registration,
        runtime: registration.runtime,
      });
    },
  };
};
