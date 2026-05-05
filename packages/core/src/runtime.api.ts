// @mill/core/runtime — Promise facade for non-Effect callers
import { Effect, Layer } from "effect";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Mill, MillLive, MillError } from "./services/Mill";
import { EntityRegistryLive } from "./services/EntityRegistry";
import { EventAppenderLive } from "./services/EventAppender";
import { PathServiceLive } from "./services/PathService";
import { IdGeneratorLive } from "./services/IdGenerator";
import { ProgramHostLive } from "./services/ProgramHost";
import { AgentRuntimeStub } from "./services/AgentRuntime";
import { ShellRuntimeLive } from "./services/ShellRuntime";
import type { TaskStatus } from "./schemas/task-command";
import type { TaskResult, TaskSnapshot, TurnResult } from "./schemas/task-state";
export type {
  TaskCancelledError,
  TaskFailedError,
  TaskOutput,
  TaskResult,
  TaskTerminalError,
  TurnResult,
} from "./schemas/task-state";

export interface MillRuntime {
  readonly submit: (programPath: string) => Promise<string>;
  readonly status: (taskId: string) => Promise<TaskSnapshot>;
  readonly result: (taskId: string) => Promise<TaskResult>;
  readonly send: (taskId: string, prompt: string) => Promise<TurnResult>;
  readonly complete: (taskId: string) => Promise<void>;
  readonly cancel: (taskId: string, reason?: string) => Promise<void>;
  readonly list: (opts?: { all?: boolean; status?: TaskStatus }) => Promise<ReadonlyArray<string>>;
}

export const createMillRuntime = (options: { tasksDirectory?: string } = {}): MillRuntime => {
  const tasksDirectory = options.tasksDirectory ?? `${process.env.HOME ?? "/tmp"}/.mill/tasks`;

  const fsLayer = EventAppenderLive.pipe(
    Layer.provide(PathServiceLive(tasksDirectory)),
    Layer.provide(BunServices.layer),
  );

  const registryLayer = EntityRegistryLive.pipe(
    Layer.provide(fsLayer),
    Layer.provide(IdGeneratorLive),
  );

  const millLayer = MillLive.pipe(
    Layer.provide(registryLayer),
    Layer.provide(
      ProgramHostLive.pipe(
        Layer.provide(registryLayer),
        Layer.provide(fsLayer),
        Layer.provide(AgentRuntimeStub),
        Layer.provide(ShellRuntimeLive.pipe(Layer.provide(BunServices.layer))),
      ),
    ),
    Layer.provide(fsLayer),
    Layer.provide(IdGeneratorLive),
  );

  const run = <A, E>(effect: Effect.Effect<A, E, Mill>): Promise<A> => {
    const program = Effect.provide(effect, millLayer);
    return Effect.runPromise(program);
  };

  return {
    submit: (programPath) =>
      run(
        Effect.gen(function* () {
          const mill = yield* Mill;
          return yield* mill.submit(programPath);
        }),
      ),
    status: (taskId) =>
      run(
        Effect.gen(function* () {
          const mill = yield* Mill;
          return yield* mill.status(taskId);
        }),
      ),
    result: (taskId) =>
      run(
        Effect.gen(function* () {
          const mill = yield* Mill;
          return yield* mill.result(taskId);
        }),
      ),
    send: (taskId, prompt) =>
      run(
        Effect.gen(function* () {
          const mill = yield* Mill;
          return yield* mill.send(taskId, prompt);
        }),
      ),
    complete: (taskId) =>
      run(
        Effect.gen(function* () {
          const mill = yield* Mill;
          return yield* mill.complete(taskId);
        }),
      ),
    cancel: (taskId, reason) =>
      run(
        Effect.gen(function* () {
          const mill = yield* Mill;
          return yield* mill.cancel(taskId, reason);
        }),
      ),
    list: (opts) =>
      run(
        Effect.gen(function* () {
          const mill = yield* Mill;
          return yield* mill.list(opts);
        }),
      ),
  };
};
