import { Context, Data, Effect, Fiber, Layer, Option, Ref, Stream } from "effect";
import type { TaskEvent } from "../schemas/task-event";
import {
  TaskCancelledError,
  TaskFailedError,
  type TaskResult,
  type TaskSnapshot,
  type TurnResult,
} from "../schemas/task-state";
import { isTerminalStatus, reduceEvents } from "../task-reducer";
import { EntityRegistry } from "./EntityRegistry";
import { EventAppender } from "./EventAppender";
import { IdGenerator } from "./IdGenerator";
import { ProgramHost } from "./ProgramHost";

export class MillError extends Data.TaggedError("MillError")<{
  readonly taskId?: string;
  readonly message: string;
}> {}

export type Mill = {
  readonly submit: (programPath: string) => Effect.Effect<string, MillError>;
  readonly prepare: (programPath: string) => Effect.Effect<string, MillError>;
  readonly executePrepared: (taskId: string, programPath: string) => Effect.Effect<void, MillError>;
  readonly status: (taskId: string) => Effect.Effect<TaskSnapshot, MillError>;
  readonly result: (taskId: string) => Effect.Effect<TaskResult, MillError>;
  readonly watch: (
    taskId: string,
    opts?: {
      readonly shallow?: boolean;
      readonly include?: ReadonlyArray<TaskEvent["type"] | string>;
      readonly exclude?: ReadonlyArray<TaskEvent["type"] | string>;
    },
  ) => Stream.Stream<TaskEvent, MillError>;
  readonly send: (taskId: string, prompt: string) => Effect.Effect<TurnResult, MillError>;
  readonly complete: (taskId: string) => Effect.Effect<void, MillError>;
  readonly cancel: (taskId: string, reason?: string) => Effect.Effect<void, MillError>;
  readonly list: (opts?: { all?: boolean }) => Effect.Effect<ReadonlyArray<string>, MillError>;
};

const now = (): string => new Date().toISOString();

const terminalResultFromEvents = (
  taskId: string,
  events: ReadonlyArray<TaskEvent>,
): TaskResult | undefined => {
  const terminalEvent = events
    .filter(
      (event) =>
        event.taskId === taskId &&
        (event.type === "task:completed" ||
          event.type === "task:failed" ||
          event.type === "task:cancelled"),
    )
    .at(-1);

  if (terminalEvent?.type === "task:completed") {
    return {
      status: "completed",
      output: { kind: "agent", text: terminalEvent.payload.result ?? "" },
    };
  }

  if (terminalEvent?.type === "task:failed") {
    return {
      status: "failed",
      error: new TaskFailedError({ taskId, message: terminalEvent.payload.error }),
    };
  }

  if (terminalEvent?.type === "task:cancelled") {
    return {
      status: "cancelled",
      error: new TaskCancelledError({
        taskId,
        message: terminalEvent.payload.reason ?? "Cancelled",
      }),
    };
  }

  return undefined;
};

export const makeMill = Effect.gen(function* () {
  const registry = yield* EntityRegistry;
  const eventAppender = yield* EventAppender;
  const idGenerator = yield* IdGenerator;
  const programHost = yield* ProgramHost;

  const prepare = (programPath: string): Effect.Effect<string, MillError> =>
    Effect.gen(function* () {
      const taskId = yield* idGenerator.generateTaskId;
      const created: TaskEvent = {
        taskId,
        sequence: 0,
        timestamp: now(),
        type: "task:created",
        payload: { kind: "program", input: programPath },
      };
      yield* eventAppender.append(taskId, created);

      const started: TaskEvent = {
        taskId,
        sequence: 0,
        timestamp: now(),
        type: "task:started",
        payload: {},
      };
      yield* eventAppender.append(taskId, started);
      return taskId;
    }).pipe(
      Effect.catch((error) =>
        Effect.fail(
          new MillError({
            message: `Failed to prepare program task: ${String(error)}`,
          }),
        ),
      ),
    );

  const executePrepared = (taskId: string, programPath: string): Effect.Effect<void, MillError> =>
    Effect.gen(function* () {
      const events = yield* eventAppender.readEvents(taskId);
      const entity = yield* registry.getOrCreate(taskId, taskId);
      for (const event of events.filter((event) => event.taskId === taskId)) {
        yield* entity.applyEvent(event);
      }

      yield* programHost.runProgram(programPath, taskId).pipe(
        Effect.flatMap((result) => {
          const event: TaskEvent = {
            taskId,
            sequence: 0,
            timestamp: now(),
            type: "task:completed",
            payload: { result: typeof result === "string" ? result : JSON.stringify(result) },
          };
          return eventAppender
            .append(taskId, event)
            .pipe(Effect.flatMap((persistedEvent) => entity.applyEvent(persistedEvent)));
        }),
        Effect.catch((error) => {
          const event: TaskEvent = {
            taskId,
            sequence: 0,
            timestamp: now(),
            type: "task:failed",
            payload: { error: String(error) },
          };
          return eventAppender.append(taskId, event).pipe(
            Effect.flatMap((persistedEvent) => entity.applyEvent(persistedEvent)),
            Effect.catch(() => Effect.void),
          );
        }),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.fail(
          new MillError({
            taskId,
            message: `Failed to execute prepared program task: ${String(error)}`,
          }),
        ),
      ),
    );

  const submit = (programPath: string): Effect.Effect<string, MillError> =>
    Effect.gen(function* () {
      const taskId = yield* idGenerator.generateTaskId;
      const entity = yield* registry.getOrCreate(taskId, taskId);
      const created: TaskEvent = {
        taskId,
        sequence: 0,
        timestamp: now(),
        type: "task:created",
        payload: { kind: "program", input: programPath },
      };
      const persistedCreated = yield* eventAppender.append(taskId, created);
      yield* entity.applyEvent(persistedCreated);

      const started: TaskEvent = {
        taskId,
        sequence: 0,
        timestamp: now(),
        type: "task:started",
        payload: {},
      };
      const persistedStarted = yield* eventAppender.append(taskId, started);
      yield* entity.applyEvent(persistedStarted);
      yield* entity.query({ _tag: "GetTask", taskId });
      yield* Effect.forkDetach(executePrepared(taskId, programPath));
      return taskId;
    }).pipe(
      Effect.catch((error) =>
        Effect.fail(
          new MillError({
            message: `Failed to submit program: ${String(error)}`,
          }),
        ),
      ),
    );

  const status = (taskId: string): Effect.Effect<TaskSnapshot, MillError> =>
    Effect.gen(function* () {
      const entity = yield* registry.lookup(taskId);
      if (entity === undefined) {
        const rootTaskId = yield* eventAppender.resolveRootTaskId(taskId);
        if (rootTaskId === undefined) {
          return yield* Effect.fail(new MillError({ taskId, message: "Task not found" }));
        }

        const events = yield* eventAppender.readEvents(rootTaskId);
        if (events.length === 0) {
          return yield* Effect.fail(new MillError({ taskId, message: "Task not found" }));
        }
        const taskEvents = events.filter((event) => event.taskId === taskId);
        if (taskEvents.length === 0) {
          return yield* Effect.fail(new MillError({ taskId, message: "Task not found" }));
        }
        return reduceEvents(taskId, taskEvents).snapshot;
      }
      return yield* entity.snapshot;
    }).pipe(
      Effect.catch((error) =>
        Effect.fail(
          new MillError({
            taskId,
            message: `Failed to get status: ${String(error)}`,
          }),
        ),
      ),
    );

  const result = (taskId: string): Effect.Effect<TaskResult, MillError> =>
    Effect.gen(function* () {
      const entity = yield* registry.lookup(taskId);
      if (entity !== undefined) {
        return yield* entity.result;
      }

      const rootTaskId = yield* eventAppender.resolveRootTaskId(taskId);
      if (rootTaskId === undefined) {
        return yield* Effect.fail(new MillError({ taskId, message: "Task not found" }));
      }

      const events = yield* eventAppender.readEvents(rootTaskId);
      const taskResult = terminalResultFromEvents(taskId, events);
      if (taskResult === undefined) {
        return yield* Effect.fail(
          new MillError({
            taskId,
            message: "Task is not active and has not reached a terminal status",
          }),
        );
      }

      return taskResult;
    }).pipe(
      Effect.catch((error) =>
        Effect.fail(
          error instanceof MillError
            ? error
            : new MillError({
                taskId,
                message: `Failed to get task result: ${String(error)}`,
              }),
        ),
      ),
    );

  const watch = (
    taskId: string,
    opts?: {
      readonly shallow?: boolean;
      readonly include?: ReadonlyArray<TaskEvent["type"] | string>;
      readonly exclude?: ReadonlyArray<TaskEvent["type"] | string>;
    },
  ): Stream.Stream<TaskEvent, MillError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const rootTaskId = yield* eventAppender
          .resolveRootTaskId(taskId)
          .pipe(
            Effect.mapError(
              (error) => new MillError({ taskId, message: `Watch error: ${String(error)}` }),
            ),
          );

        if (rootTaskId === undefined) {
          return Stream.fail(new MillError({ taskId, message: "Task not found" }));
        }

        let events = eventAppender
          .watchFromFile(rootTaskId)
          .pipe(
            Stream.mapError(
              (error) => new MillError({ taskId, message: `Watch error: ${String(error)}` }),
            ),
          );

        if (opts?.shallow) {
          events = events.pipe(Stream.filter((event) => event.taskId === taskId));
        } else if (taskId !== rootTaskId) {
          const descendantsRef = yield* Ref.make<Set<string>>(new Set([taskId]));
          events = events.pipe(
            Stream.filterEffect((event) =>
              Ref.modify(descendantsRef, (descendants) => {
                const next = new Set(descendants);
                const includeEvent = next.has(event.taskId);

                if (includeEvent && event.type === "task:child_spawned") {
                  next.add(event.payload.childId);
                }

                return [includeEvent, next];
              }),
            ),
          );
        }

        const include = opts?.include !== undefined ? new Set(opts.include) : undefined;
        const exclude = opts?.exclude !== undefined ? new Set(opts.exclude) : undefined;

        if (include !== undefined) {
          events = events.pipe(Stream.filter((event) => include.has(event.type)));
        }

        if (exclude !== undefined) {
          events = events.pipe(Stream.filter((event) => !exclude.has(event.type)));
        }

        return events;
      }),
    );

  const send = (taskId: string, prompt: string): Effect.Effect<TurnResult, MillError> =>
    Effect.gen(function* () {
      const entity = yield* registry.lookup(taskId);
      if (entity === undefined) {
        return yield* Effect.fail(new MillError({ taskId, message: "Task not found" }));
      }

      const snapshot = yield* entity.snapshot;
      if (isTerminalStatus(snapshot.status)) {
        return yield* Effect.fail(
          new MillError({
            taskId,
            message:
              snapshot.status === "cancelled"
                ? "Cancelled"
                : snapshot.status === "failed"
                  ? "Task failed"
                  : "Task completed",
          }),
        );
      }

      const rootTaskId = entity.rootTaskId;
      const sequence = yield* entity.reserveTurn;
      const turn = eventAppender.watch(rootTaskId).pipe(
        Stream.filter((event) => {
          if (event.taskId !== taskId) {
            return false;
          }
          if (event.type === "task:turn_completed") {
            return event.payload.sequence === sequence;
          }
          return event.type === "task:failed" || event.type === "task:cancelled";
        }),
        Stream.runHead,
        Effect.flatMap((option) => {
          if (Option.isNone(option)) {
            return Effect.fail(new MillError({ taskId, message: "Turn stream ended" }));
          }
          const event = option.value;
          if (event.type === "task:turn_completed") {
            return Effect.succeed(event.payload);
          }
          if (event.type === "task:failed") {
            return Effect.fail(new MillError({ taskId, message: event.payload.error }));
          }
          if (event.type === "task:cancelled") {
            return Effect.fail(
              new MillError({ taskId, message: event.payload.reason ?? "Cancelled" }),
            );
          }
          return Effect.fail(new MillError({ taskId, message: "Unexpected turn event" }));
        }),
      );

      const fiber = yield* Effect.forkScoped(turn);
      yield* entity
        .send({ _tag: "SendMessage", taskId, content: prompt, sequence })
        .pipe(Effect.mapError((error) => new MillError({ taskId, message: error.message })));
      return yield* Fiber.join(fiber);
    }).pipe(
      Effect.scoped,
      Effect.catch((error) =>
        Effect.fail(
          error instanceof MillError
            ? error
            : new MillError({ taskId, message: `Failed to send prompt: ${String(error)}` }),
        ),
      ),
    );

  const complete = (taskId: string): Effect.Effect<void, MillError> =>
    Effect.gen(function* () {
      const entity = yield* registry.lookup(taskId);
      if (entity === undefined) {
        return yield* Effect.fail(new MillError({ taskId, message: "Task not found" }));
      }
      yield* entity.send({ _tag: "CompleteTask", taskId });
    }).pipe(
      Effect.catch((error) =>
        Effect.fail(
          error instanceof MillError
            ? error
            : new MillError({ taskId, message: `Failed to complete task: ${String(error)}` }),
        ),
      ),
    );

  const cancel = (taskId: string, reason?: string): Effect.Effect<void, MillError> =>
    Effect.gen(function* () {
      const cancelRecursive = (id: string): Effect.Effect<void, MillError> =>
        Effect.gen(function* () {
          const entity = yield* registry.lookup(id);
          if (entity === undefined) {
            const rootTaskId = yield* eventAppender.resolveRootTaskId(id);
            if (rootTaskId === undefined) {
              return yield* Effect.fail(new MillError({ taskId: id, message: "Task not found" }));
            }

            const events = yield* eventAppender.readEvents(rootTaskId);
            const taskEvents = events.filter((event) => event.taskId === id);
            if (taskEvents.length === 0) {
              return yield* Effect.fail(new MillError({ taskId: id, message: "Task not found" }));
            }

            const snapshot = reduceEvents(id, taskEvents).snapshot;
            if (!isTerminalStatus(snapshot.status)) {
              const event: TaskEvent = {
                taskId: id,
                sequence: 0,
                timestamp: now(),
                type: "task:cancelled",
                payload: { reason },
              };
              yield* eventAppender.append(rootTaskId, event);
            }
            return;
          }

          const children = yield* entity.query({ _tag: "GetChildTasks", taskId: id });
          yield* entity.cancel(reason);

          if (Array.isArray(children)) {
            for (const childId of children) {
              yield* cancelRecursive(childId);
            }
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.fail(
              error instanceof MillError
                ? error
                : new MillError({ taskId: id, message: `Failed to cancel task: ${String(error)}` }),
            ),
          ),
        );

      yield* cancelRecursive(taskId);
    }).pipe(
      Effect.catch((error) =>
        Effect.fail(
          new MillError({
            taskId,
            message: `Failed to cancel task: ${String(error)}`,
          }),
        ),
      ),
    );

  const list = (opts?: { all?: boolean }): Effect.Effect<ReadonlyArray<string>, MillError> =>
    Effect.gen(function* () {
      const liveIds = yield* registry.list();
      const diskRootIds = yield* eventAppender.listRootTaskIds();
      const ids = new Set<string>(diskRootIds);

      if (opts?.all) {
        for (const liveId of liveIds) {
          ids.add(liveId);
        }

        for (const rootTaskId of diskRootIds) {
          const events = yield* eventAppender
            .readEvents(rootTaskId)
            .pipe(Effect.catch(() => Effect.succeed([])));
          for (const event of events) {
            ids.add(event.taskId);
            if (event.type === "task:child_spawned") {
              ids.add(event.payload.childId);
            }
          }
        }
      } else {
        for (const liveId of liveIds) {
          const entity = yield* registry.lookup(liveId);
          if (entity !== undefined && entity.rootTaskId === entity.taskId) {
            ids.add(liveId);
          }
        }
      }

      return Array.from(ids).sort();
    }).pipe(
      Effect.catch((error) =>
        Effect.fail(
          new MillError({
            message: `Failed to list tasks: ${String(error)}`,
          }),
        ),
      ),
    );

  return {
    submit,
    prepare,
    executePrepared,
    status,
    result,
    watch,
    send,
    complete,
    cancel,
    list,
  } satisfies Mill;
});

export const Mill = Context.Service<Mill>("@mill/core/Mill");

export const MillLive = Layer.effect(Mill, makeMill);
