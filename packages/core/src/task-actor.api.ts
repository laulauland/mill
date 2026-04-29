import { Deferred, Effect } from "effect";
import type {
  RunActor,
  RunSnapshot,
  TaskActor,
  TaskCommand,
  TaskInput,
  TaskRef,
  TaskResult,
  TaskSnapshot,
  TaskStatus,
} from "./types";

export interface Subscription {
  readonly unsubscribe: () => void;
}

export interface TaskActorOptions {
  readonly execute: (input: TaskInput) => Promise<TaskResult>;
  readonly runId?: string;
  readonly taskId?: string;
}

let nextActorId = 1;

const makeActorId = (prefix: string): string => {
  const id = `${prefix}_${nextActorId}`;
  nextActorId += 1;
  return id;
};

const makeCancelledResult = (input: TaskInput, ref: TaskRef, reason?: string): TaskResult => ({
  text: "",
  sessionRef: `task://${ref.runId}/${ref.taskId}`,
  role: input.role ?? input.agent.driver,
  model: input.agent.model,
  driver: input.agent.driver,
  exitCode: 1,
  stopReason: "cancelled",
  errorMessage: reason ?? "Task cancelled",
});

const makeInitialSnapshot = (input: TaskInput, ref: TaskRef): TaskSnapshot => ({
  id: ref.taskId,
  runId: ref.runId,
  ref,
  status: "idle",
  input,
  text: "",
  thought: "",
  queue: [],
});

const completeDeferred = <A>(deferred: Deferred.Deferred<A, unknown>, result: A): void => {
  void Effect.runPromise(Deferred.succeed(deferred, result));
};

const failDeferred = <A>(deferred: Deferred.Deferred<A, unknown>, error: unknown): void => {
  void Effect.runPromise(Deferred.fail(deferred, error));
};

const errorMessageFromUnknown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createTaskActor = (input: TaskInput, options: TaskActorOptions): TaskActor => {
  const ref: TaskRef = {
    runId: options.runId ?? makeActorId("run"),
    taskId: options.taskId ?? makeActorId("task"),
  };
  const deferred = Effect.runSync(Deferred.make<TaskResult, unknown>());
  const listeners = new Set<(snapshot: TaskSnapshot) => void>();
  let snapshot = makeInitialSnapshot(input, ref);
  let started = false;
  let terminal = false;

  const publish = (next: TaskSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const setStatus = (status: TaskStatus, extra?: Partial<TaskSnapshot>): void => {
    publish({ ...snapshot, ...extra, status });
  };

  const actor: TaskActor = {
    id: ref.taskId,
    ref,
    done: Effect.runPromise(Deferred.await(deferred)),
    start: () => {
      if (started || terminal) {
        return actor;
      }

      started = true;
      setStatus("running");

      options.execute(input).then(
        (result) => {
          if (terminal) {
            return;
          }

          terminal = true;
          setStatus("complete", {
            text: result.text,
            sessionRef: result.sessionRef,
            result,
          });
          completeDeferred(deferred, result);
        },
        (error: unknown) => {
          if (terminal) {
            return;
          }

          terminal = true;
          setStatus("failed", {
            error: errorMessageFromUnknown(error),
          });
          failDeferred(deferred, error);
        },
      );

      return actor;
    },
    stop: () => actor.cancel("Task stopped"),
    cancel: (reason?: string) => {
      if (terminal) {
        return actor;
      }

      terminal = true;
      const result = makeCancelledResult(input, ref, reason);
      setStatus("cancelled", {
        result,
        error: result.errorMessage,
      });
      completeDeferred(deferred, result);
      return actor;
    },
    send: (command: TaskCommand) => {
      if (command.type === "cancel") {
        return actor.cancel(command.reason);
      }

      publish({
        ...snapshot,
        error: "Task steering commands are not implemented yet.",
      });
      return actor;
    },
    subscribe: (listener: (snapshot: TaskSnapshot) => void): Subscription => {
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

export interface RunActorOptions {
  readonly runId?: string;
  readonly result?: unknown;
}

const makeInitialRunSnapshot = (id: string): RunSnapshot => ({
  id,
  status: "idle",
  tasks: {},
});

export const createRunActor = (options: RunActorOptions = {}): RunActor => {
  const id = options.runId ?? makeActorId("run");
  const deferred = Effect.runSync(Deferred.make<unknown, unknown>());
  const listeners = new Set<(snapshot: RunSnapshot) => void>();
  let snapshot = makeInitialRunSnapshot(id);
  let terminal = false;

  const publish = (next: RunSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const actor: RunActor = {
    id,
    done: Effect.runPromise(Deferred.await(deferred)),
    start: () => {
      if (terminal || snapshot.status !== "idle") {
        return actor;
      }

      terminal = true;
      publish({ ...snapshot, status: "complete", result: options.result });
      completeDeferred(deferred, options.result);
      return actor;
    },
    stop: () => actor.cancel("Run stopped"),
    cancel: (reason?: string) => {
      if (terminal) {
        return actor;
      }

      terminal = true;
      publish({ ...snapshot, status: "cancelled", error: reason ?? "Run cancelled" });
      completeDeferred(deferred, options.result);
      return actor;
    },
    task: (taskInput: TaskInput) => {
      const task = createTaskActor(taskInput, {
        execute: async () => ({
          text: "",
          sessionRef: `task://${id}/${makeActorId("task_session")}`,
          role: taskInput.role ?? taskInput.agent.driver,
          model: taskInput.agent.model,
          driver: taskInput.agent.driver,
          exitCode: 0,
        }),
        runId: id,
      });
      publish({
        ...snapshot,
        tasks: {
          ...snapshot.tasks,
          [task.id]: task.getSnapshot(),
        },
      });
      task.subscribe((taskSnapshot) => {
        publish({
          ...snapshot,
          tasks: {
            ...snapshot.tasks,
            [task.id]: taskSnapshot,
          },
        });
      });
      return task;
    },
    taskRef: (taskId: string) =>
      createTaskActor(
        {
          agent: { driver: "unknown", model: "unknown" },
          prompt: "",
        },
        {
          execute: async () => ({
            text: "",
            sessionRef: `task://${id}/${taskId}`,
            role: "unknown",
            model: "unknown",
            driver: "unknown",
            exitCode: 0,
          }),
          runId: id,
          taskId,
        },
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
