import { Context, Effect } from "effect";
import {
  makeRunActorRuntime,
  makeTaskActorRuntime,
  type RunActorRuntimeOptions,
  type TaskActorRuntime,
  type TaskActorRuntimeOptions,
} from "./task-actor.effect";
import type { RunActor, RunSnapshot, TaskActor, TaskInput, TaskResult } from "./types";

export interface Subscription {
  readonly unsubscribe: () => void;
}

export interface TaskActorOptions {
  readonly execute: (input: TaskInput) => Promise<TaskResult>;
  readonly runId?: string;
  readonly taskId?: string;
}

export interface EffectTaskActorOptions {
  readonly execute: TaskActorRuntimeOptions["execute"];
  readonly runId?: string;
  readonly taskId?: string;
  readonly onComplete?: (result: TaskResult) => void;
  readonly services?: Context.Context<never>;
}

export type { RunActorRuntimeOptions as RunActorOptions };

const promiseExecutorToEffect =
  (execute: TaskActorOptions["execute"]): TaskActorRuntimeOptions["execute"] =>
  (input) =>
    Effect.tryPromise({
      try: () => execute(input),
      catch: (error) => error,
    });

const runSync = <A>(effect: Effect.Effect<A>): A => Effect.runSync(effect);

const createTaskActorFromRuntime = (
  runtime: TaskActorRuntime,
  options: Pick<EffectTaskActorOptions, "onComplete" | "services"> = {},
): TaskActor => {
  const runPromise =
    options.services === undefined ? Effect.runPromise : Effect.runPromiseWith(options.services);
  const actor: TaskActor = {
    id: runtime.id,
    ref: runtime.ref,
    done: runPromise(
      runtime.done.pipe(
        Effect.tap((result) =>
          options.onComplete === undefined
            ? Effect.void
            : Effect.sync(() => options.onComplete?.(result)),
        ),
      ),
    ),
    start: () => {
      void runPromise(runtime.start);
      return actor;
    },
    stop: () => actor.cancel("Task stopped"),
    cancel: (reason?: string) => {
      void runPromise(runtime.cancel(reason));
      return actor;
    },
    send: (command) => {
      void runPromise(runtime.send(command));
      return actor;
    },
    subscribe: runtime.subscribe,
    getSnapshot: runtime.getSnapshot,
  };

  return actor;
};

export const createTaskActorFromEffect = (
  input: TaskInput,
  options: EffectTaskActorOptions,
): TaskActor => {
  const runtime = runSync(
    makeTaskActorRuntime(input, {
      execute: options.execute,
      runId: options.runId,
      taskId: options.taskId,
    }),
  );

  return createTaskActorFromRuntime(runtime, {
    onComplete: options.onComplete,
    services: options.services,
  });
};

export const createTaskActor = (input: TaskInput, options: TaskActorOptions): TaskActor =>
  createTaskActorFromEffect(input, {
    execute: promiseExecutorToEffect(options.execute),
    runId: options.runId,
    taskId: options.taskId,
  });

const createNoopTask = (input: TaskInput, runId: string, taskId?: string): TaskActor =>
  createTaskActor(input, {
    execute: async () => ({
      text: "",
      sessionRef: `task://${runId}/${taskId ?? "task_session"}`,
      role: input.role ?? input.agent.driver,
      model: input.agent.model,
      driver: input.agent.driver,
      exitCode: 0,
    }),
    runId,
    taskId,
  });

const attachTaskSnapshot = (
  getRunSnapshot: () => RunSnapshot,
  publishRunSnapshot: (snapshot: RunSnapshot) => void,
  task: TaskActor,
): void => {
  publishRunSnapshot({
    ...getRunSnapshot(),
    tasks: {
      ...getRunSnapshot().tasks,
      [task.id]: task.getSnapshot(),
    },
  });
  task.subscribe((taskSnapshot) => {
    const runSnapshot = getRunSnapshot();
    publishRunSnapshot({
      ...runSnapshot,
      tasks: {
        ...runSnapshot.tasks,
        [task.id]: taskSnapshot,
      },
    });
  });
};

export const createRunActor = (options: RunActorRuntimeOptions = {}): RunActor => {
  const runtime = runSync(makeRunActorRuntime(options));
  const listeners = new Set<(snapshot: RunSnapshot) => void>();
  let snapshot = runtime.getSnapshot();

  const publishSnapshot = (next: RunSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  runtime.subscribe((runtimeSnapshot) => {
    publishSnapshot({
      ...runtimeSnapshot,
      tasks: snapshot.tasks,
    });
  });

  const actor: RunActor = {
    id: runtime.id,
    done: Effect.runPromise(runtime.done),
    start: () => {
      runSync(runtime.start);
      return actor;
    },
    stop: () => actor.cancel("Run stopped"),
    cancel: (reason?: string) => {
      runSync(runtime.cancel(reason));
      return actor;
    },
    task: (taskInput: TaskInput) => {
      const task = createNoopTask(taskInput, runtime.id);
      attachTaskSnapshot(() => snapshot, publishSnapshot, task);
      return task;
    },
    taskRef: (taskId: string) =>
      createNoopTask(
        {
          agent: { driver: "unknown", model: "unknown" },
          prompt: "",
        },
        runtime.id,
        taskId,
      ),
    subscribe: (listener: (snapshot: RunSnapshot) => void): Subscription => {
      listeners.add(listener);
      listener(snapshot);
      return {
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
    getSnapshot: () => snapshot,
  };

  return actor;
};
