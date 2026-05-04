import { Context, Data, Deferred, Effect, Option, Queue, Ref, Stream } from "effect";
import type { TaskCommand, TaskQuery } from "../schemas/task-command";
import type { TaskEvent } from "../schemas/task-event";
import {
  TaskCancelledError,
  TaskFailedError,
  type TaskOutput,
  type TaskResult,
  type TaskSnapshot,
  type TaskTerminalError,
} from "../schemas/task-state";
import { EventAppender } from "./EventAppender";
import { IdGenerator } from "./IdGenerator";
import type { TurnPrompt } from "./AgentRuntime";
import { reduceEvent, type ReducerState } from "../task-reducer";

export class TaskEntityError extends Data.TaggedError("TaskEntityError")<{
  readonly taskId: string;
  readonly message: string;
}> {}

export type TaskEntity = {
  readonly taskId: string;
  readonly rootTaskId: string;
  readonly parentId: string | undefined;
  readonly send: (command: TaskCommand) => Effect.Effect<void, TaskEntityError>;
  readonly query: (query: TaskQuery) => Effect.Effect<unknown, TaskEntityError>;
  readonly snapshot: Effect.Effect<TaskSnapshot>;
  readonly await: Effect.Effect<TaskOutput, TaskTerminalError>;
  readonly result: Effect.Effect<TaskResult>;
  readonly watch: Stream.Stream<TaskEvent>;
  readonly userInbox: Queue.Queue<TurnPrompt>;
  readonly reserveTurn: Effect.Effect<number>;
  readonly completionSignal: Effect.Effect<void>;
  readonly cancel: (reason?: string) => Effect.Effect<void, TaskEntityError>;
  readonly applyEvent: (event: TaskEvent) => Effect.Effect<void, TaskEntityError>;
  readonly spawnChild: (
    kind: "program" | "agent",
    input?: string,
  ) => Effect.Effect<string, TaskEntityError>;
};

const buildInitialState = (taskId: string): ReducerState => ({
  snapshot: {
    id: taskId,
    status: "created",
    text: "",
    thought: "",
    busy: false,
    history: [],
  },
  children: [],
});

const now = (): string => new Date().toISOString();

export const makeTaskEntity = ({
  taskId,
  rootTaskId,
  parentId,
}: {
  taskId: string;
  rootTaskId: string;
  parentId?: string;
}): Effect.Effect<TaskEntity, never, EventAppender | IdGenerator> =>
  Effect.gen(function* () {
    const eventAppender = yield* EventAppender;
    const idGenerator = yield* IdGenerator;
    const stateRef = yield* Ref.make(buildInitialState(taskId));
    const commandQueue = yield* Queue.unbounded<TaskCommand>();
    const queryQueue = yield* Queue.unbounded<{
      query: TaskQuery;
      deferred: Deferred.Deferred<unknown, TaskEntityError>;
    }>();
    const terminalDeferred = yield* Deferred.make<TaskOutput, TaskTerminalError>();
    const completionDeferred = yield* Deferred.make<void>();
    const userInbox = yield* Queue.unbounded<TurnPrompt>();
    const nextTurnSequenceRef = yield* Ref.make(1);

    let isTerminal = false;

    const getSnapshot = (): Effect.Effect<TaskSnapshot> =>
      Ref.get(stateRef).pipe(Effect.map((s) => s.snapshot));

    const applyEvent = (event: TaskEvent): Effect.Effect<void, TaskEntityError> =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        const nextState = reduceEvent(state, event);
        yield* Ref.set(stateRef, nextState);

        if (event.type === "task:completed") {
          isTerminal = true;
          yield* Deferred.succeed(completionDeferred, undefined);
          yield* Deferred.succeed(terminalDeferred, {
            kind: "agent" as const,
            text: event.payload.result ?? "",
          });
        }

        if (event.type === "task:failed") {
          isTerminal = true;
          yield* Deferred.succeed(completionDeferred, undefined);
          yield* Deferred.fail(
            terminalDeferred,
            new TaskFailedError({ taskId, message: event.payload.error }),
          );
        }

        if (event.type === "task:cancelled") {
          isTerminal = true;
          yield* Deferred.succeed(completionDeferred, undefined);
          yield* Deferred.fail(
            terminalDeferred,
            new TaskCancelledError({ taskId, message: event.payload.reason ?? "Cancelled" }),
          );
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.fail(
            new TaskEntityError({
              taskId,
              message: `Failed to apply event ${event.type}: ${String(error)}`,
            }),
          ),
        ),
      );

    const handleCommand = (command: TaskCommand): Effect.Effect<void, TaskEntityError> =>
      Effect.gen(function* () {
        if (isTerminal) {
          return yield* Effect.fail(
            new TaskEntityError({ taskId, message: `Task is already terminal` }),
          );
        }

        switch (command._tag) {
          case "CreateTask": {
            const event: TaskEvent = {
              taskId,
              sequence: 0,
              timestamp: now(),
              type: "task:created",
              payload: {
                parentId: command.parentId,
                kind: command.kind,
                input: command.input,
              },
            };
            const persistedEvent = yield* eventAppender.append(rootTaskId, event);
            yield* applyEvent(persistedEvent);
            break;
          }
          case "SendMessage": {
            const snapshot = yield* getSnapshot();
            if (snapshot.status === "created") {
              const started: TaskEvent = {
                taskId,
                sequence: 0,
                timestamp: now(),
                type: "task:started",
                payload: {},
              };
              const persistedStarted = yield* eventAppender.append(rootTaskId, started);
              yield* applyEvent(persistedStarted);
            } else if (snapshot.busy) {
              yield* Ref.update(stateRef, (state) => ({
                ...state,
                snapshot: {
                  ...state.snapshot,
                  pending: { type: "message" as const, content: command.content },
                },
              }));
            }
            const sequence = command.sequence ?? (yield* reserveTurn);
            yield* Queue.offer(userInbox, { prompt: command.content, sequence });
            break;
          }
          case "CompleteTask": {
            yield* Deferred.succeed(completionDeferred, undefined);
            break;
          }
          case "CancelTask": {
            const event: TaskEvent = {
              taskId,
              sequence: 0,
              timestamp: now(),
              type: "task:cancelled",
              payload: { reason: command.reason },
            };
            const persistedEvent = yield* eventAppender.append(rootTaskId, event);
            yield* applyEvent(persistedEvent);
            break;
          }
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.fail(
            new TaskEntityError({
              taskId,
              message: `Command ${command._tag} failed: ${String(error)}`,
            }),
          ),
        ),
      );

    const handleQuery = ({
      query,
      deferred,
    }: {
      query: TaskQuery;
      deferred: Deferred.Deferred<unknown, TaskEntityError>;
    }): Effect.Effect<void> =>
      Effect.gen(function* () {
        const result = yield* answerQuery(query);
        yield* Deferred.succeed(deferred, result);
      });

    const answerQuery = (query: TaskQuery): Effect.Effect<unknown> =>
      Effect.gen(function* () {
        switch (query._tag) {
          case "GetTask":
            return yield* getSnapshot();
          case "ListTasks":
          case "GetChildTasks": {
            const state = yield* Ref.get(stateRef);
            return state.children;
          }
        }
      });

    const runLoop = Effect.gen(function* () {
      while (!isTerminal) {
        const maybeCommand = yield* Queue.poll(commandQueue);
        if (Option.isSome(maybeCommand)) {
          yield* handleCommand(maybeCommand.value);
        }

        const maybeQuery = yield* Queue.poll(queryQueue);
        if (Option.isSome(maybeQuery)) {
          yield* handleQuery(maybeQuery.value);
        }

        if (Option.isNone(maybeCommand) && Option.isNone(maybeQuery)) {
          yield* Effect.sleep("10 millis");
        }
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const event: TaskEvent = {
            taskId,
            sequence: 0,
            timestamp: now(),
            type: "task:failed",
            payload: { error: String(error) },
          };
          const persistedEvent = yield* eventAppender
            .append(rootTaskId, event)
            .pipe(Effect.catch(() => Effect.succeed(event)));
          isTerminal = true;
          yield* applyEvent(persistedEvent).pipe(Effect.catch(() => Effect.void));
        }),
      ),
    );

    const reserveTurn = Ref.getAndUpdate(nextTurnSequenceRef, (next) => next + 1);

    yield* Effect.forkDetach(runLoop);

    const terminalResult: Effect.Effect<TaskResult> = Effect.matchEffect(
      Deferred.await(terminalDeferred),
      {
        onFailure: (error) =>
          Effect.succeed(
            error instanceof TaskCancelledError
              ? { status: "cancelled" as const, error }
              : { status: "failed" as const, error: error as unknown as TaskFailedError },
          ),
        onSuccess: (output) => Effect.succeed({ status: "completed" as const, output }),
      },
    );

    const spawnChild = (
      kind: "program" | "agent",
      _input?: string,
    ): Effect.Effect<string, TaskEntityError> =>
      Effect.gen(function* () {
        const childId = yield* idGenerator.generateTaskId;
        const event: TaskEvent = {
          taskId,
          sequence: 0,
          timestamp: now(),
          type: "task:child_spawned",
          payload: { childId, kind },
        };
        const persistedEvent = yield* eventAppender.append(rootTaskId, event);
        yield* applyEvent(persistedEvent);
        return childId;
      }).pipe(
        Effect.catch((error) =>
          Effect.fail(
            new TaskEntityError({
              taskId,
              message: `Failed to spawn child: ${String(error)}`,
            }),
          ),
        ),
      );

    return {
      taskId,
      rootTaskId,
      parentId,
      send: (command) =>
        isTerminal
          ? Effect.fail(new TaskEntityError({ taskId, message: "Task is already terminal" }))
          : Queue.offer(commandQueue, command).pipe(Effect.asVoid),
      query: (query) =>
        isTerminal
          ? answerQuery(query)
          : Effect.gen(function* () {
              const deferred = yield* Deferred.make<unknown, TaskEntityError>();
              yield* Queue.offer(queryQueue, { query, deferred });
              return yield* Deferred.await(deferred);
            }),
      snapshot: getSnapshot(),
      await: Deferred.await(terminalDeferred),
      result: terminalResult,
      watch: eventAppender.watch(rootTaskId),
      userInbox,
      reserveTurn,
      completionSignal: Deferred.await(completionDeferred),
      cancel: (reason?) =>
        Queue.offer(commandQueue, { _tag: "CancelTask", taskId, reason }).pipe(Effect.asVoid),
      applyEvent,
      spawnChild,
    } satisfies TaskEntity;
  });

export const TaskEntity = Context.Service<TaskEntity>("@mill/core/TaskEntity");
