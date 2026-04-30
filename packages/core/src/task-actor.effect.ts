import { Deferred, Effect } from "effect";
import type {
  RunSnapshot,
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

export interface TaskActorRuntimeOptions {
  readonly execute: (input: TaskInput) => Effect.Effect<TaskResult, unknown>;
  readonly runId?: string;
  readonly taskId?: string;
}

export interface TaskActorRuntime {
  readonly id: string;
  readonly ref: TaskRef;
  readonly done: Effect.Effect<TaskResult, unknown>;
  readonly start: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
  readonly cancel: (reason?: string) => Effect.Effect<void>;
  readonly send: (command: TaskCommand) => Effect.Effect<void>;
  readonly subscribe: (listener: (snapshot: TaskSnapshot) => void) => Subscription;
  readonly getSnapshot: () => TaskSnapshot;
}

export interface RunActorRuntimeOptions {
  readonly runId?: string;
  readonly result?: unknown;
}

export interface RunActorRuntime {
  readonly id: string;
  readonly done: Effect.Effect<unknown, unknown>;
  readonly start: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
  readonly cancel: (reason?: string) => Effect.Effect<void>;
  readonly subscribe: (listener: (snapshot: RunSnapshot) => void) => Subscription;
  readonly getSnapshot: () => RunSnapshot;
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

const isTaskBusy = (status: TaskStatus): boolean =>
  status === "starting" || status === "running" || status === "queued" || status === "interrupting";

const commandMode = (input: TaskInput, command: TaskCommand): "queue" | "interrupt" | "reject" => {
  if (command.type === "cancel") {
    return "interrupt";
  }

  return command.mode ?? input.steering ?? "queue";
};

const queueableCommand = (
  command: TaskCommand,
):
  | {
      readonly type: "message" | "context";
      readonly content: string;
      readonly from?: TaskRef | string;
      readonly mode: "queue" | "interrupt" | "reject";
    }
  | undefined => {
  if (command.type !== "message" && command.type !== "context") {
    return undefined;
  }

  return {
    type: command.type,
    content: command.content,
    from: command.type === "context" ? command.from : undefined,
    mode: command.mode ?? "queue",
  };
};

const makeInitialTaskSnapshot = (input: TaskInput, ref: TaskRef): TaskSnapshot => ({
  id: ref.taskId,
  runId: ref.runId,
  ref,
  status: "idle",
  input,
  text: "",
  thought: "",
  queue: [],
});

const makeInitialRunSnapshot = (id: string): RunSnapshot => ({
  id,
  status: "idle",
  tasks: {},
});

const errorMessageFromUnknown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const makeTaskActorRuntime = (
  input: TaskInput,
  options: TaskActorRuntimeOptions,
): Effect.Effect<TaskActorRuntime> =>
  Effect.gen(function* () {
    const ref: TaskRef = {
      runId: options.runId ?? makeActorId("run"),
      taskId: options.taskId ?? makeActorId("task"),
    };
    const deferred = yield* Deferred.make<TaskResult, unknown>();
    const listeners = new Set<(snapshot: TaskSnapshot) => void>();
    let snapshot = makeInitialTaskSnapshot(input, ref);
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

    const complete = (result: TaskResult): Effect.Effect<void> =>
      Effect.sync(() => {
        if (terminal) {
          return false;
        }

        terminal = true;
        setStatus("complete", {
          text: result.text,
          sessionRef: result.sessionRef,
          result,
        });
        return true;
      }).pipe(
        Effect.andThen((shouldComplete) =>
          shouldComplete ? Deferred.succeed(deferred, result) : Effect.void,
        ),
      );

    const fail = (error: unknown): Effect.Effect<void> =>
      Effect.sync(() => {
        if (terminal) {
          return false;
        }

        terminal = true;
        setStatus("failed", {
          error: errorMessageFromUnknown(error),
        });
        return true;
      }).pipe(
        Effect.andThen((shouldFail) => (shouldFail ? Deferred.fail(deferred, error) : Effect.void)),
      );

    const runExecution = options.execute(input).pipe(
      Effect.matchEffect({
        onFailure: fail,
        onSuccess: complete,
      }),
    );

    const cancel = (reason?: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const result = makeCancelledResult(input, ref, reason);
        const shouldComplete = yield* Effect.sync(() => {
          if (terminal) {
            return false;
          }

          terminal = true;
          setStatus("cancelled", {
            result,
            error: result.errorMessage,
          });
          return true;
        });

        if (shouldComplete) {
          yield* Deferred.succeed(deferred, result);
        }
      });

    const start = Effect.gen(function* () {
      const shouldStart = yield* Effect.sync(() => {
        if (started || terminal) {
          return false;
        }

        started = true;
        setStatus("running");
        return true;
      });

      if (shouldStart) {
        yield* runExecution.pipe(Effect.forkDetach({ startImmediately: true }));
      }
    });

    const sendSteeringCommand = (command: TaskCommand): Effect.Effect<void> =>
      Effect.sync(() => {
        if (terminal) {
          return;
        }

        const queued = queueableCommand(command);

        if (queued === undefined) {
          return;
        }

        const mode = commandMode(input, command);
        const item = { ...queued, mode };

        if (mode === "queue") {
          publish({
            ...snapshot,
            status:
              isTaskBusy(snapshot.status) || snapshot.status === "idle"
                ? "queued"
                : snapshot.status,
            queue: [...snapshot.queue, item],
          });
          return;
        }

        if (mode === "interrupt") {
          publish({
            ...snapshot,
            status: isTaskBusy(snapshot.status) ? "interrupting" : snapshot.status,
            error: "Task interrupt requested; driver-level interrupt is not available yet.",
            queue: [...snapshot.queue, item],
          });
          return;
        }

        publish({
          ...snapshot,
          error: isTaskBusy(snapshot.status)
            ? "Task is busy and rejected the steering command."
            : "Task rejected the steering command.",
        });
      });

    return {
      id: ref.taskId,
      ref,
      done: Deferred.await(deferred),
      start,
      stop: cancel("Task stopped"),
      cancel,
      send: (command: TaskCommand) => {
        if (command.type === "cancel") {
          return cancel(command.reason);
        }

        return sendSteeringCommand(command);
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
    } satisfies TaskActorRuntime;
  });

export const makeRunActorRuntime = (
  options: RunActorRuntimeOptions = {},
): Effect.Effect<RunActorRuntime> =>
  Effect.gen(function* () {
    const id = options.runId ?? makeActorId("run");
    const deferred = yield* Deferred.make<unknown, unknown>();
    const listeners = new Set<(snapshot: RunSnapshot) => void>();
    let snapshot = makeInitialRunSnapshot(id);
    let terminal = false;

    const publish = (next: RunSnapshot): void => {
      snapshot = next;
      for (const listener of listeners) {
        listener(snapshot);
      }
    };

    const complete = Effect.gen(function* () {
      const shouldComplete = yield* Effect.sync(() => {
        if (terminal || snapshot.status !== "idle") {
          return false;
        }

        terminal = true;
        publish({ ...snapshot, status: "complete", result: options.result });
        return true;
      });

      if (shouldComplete) {
        yield* Deferred.succeed(deferred, options.result);
      }
    });

    const cancel = (reason?: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const shouldComplete = yield* Effect.sync(() => {
          if (terminal) {
            return false;
          }

          terminal = true;
          publish({ ...snapshot, status: "cancelled", error: reason ?? "Run cancelled" });
          return true;
        });

        if (shouldComplete) {
          yield* Deferred.succeed(deferred, options.result);
        }
      });

    return {
      id,
      done: Deferred.await(deferred),
      start: complete,
      stop: cancel("Run stopped"),
      cancel,
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
    } satisfies RunActorRuntime;
  });
