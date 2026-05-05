import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Context, Data, Effect, Fiber, Layer, Option, Stream } from "effect";
import { EventAppender } from "./EventAppender";
import { EntityRegistry } from "./EntityRegistry";
import type { TaskEvent } from "../schemas/task-event";
import { enterProgramContext, makeTaskHandle } from "../program.api";
import type { TaskOptions } from "../program.api";
import { AgentRuntime } from "./AgentRuntime";
import type { TaskSnapshot, TurnResult } from "../schemas/task-state";
import { isTerminalStatus } from "../task-reducer";

export class ProgramHostError extends Data.TaggedError("ProgramHostError")<{
  readonly taskId: string;
  readonly message: string;
}> {}

export type ProgramHost = {
  readonly runProgram: (
    programPath: string,
    taskId: string,
  ) => Effect.Effect<unknown, ProgramHostError>;
};

const now = (): string => new Date().toISOString();

export const makeProgramHost = Effect.gen(function* () {
  const eventAppender = yield* EventAppender;
  const registry = yield* EntityRegistry;
  const agentRuntime = yield* AgentRuntime;

  const runProgram = (
    programPath: string,
    taskId: string,
  ): Effect.Effect<unknown, ProgramHostError> =>
    Effect.gen(function* () {
      const originalLog = globalThis.console.log;
      const originalError = globalThis.console.error;
      const ioWrites: Array<Promise<unknown>> = [];
      let nextChild = 0;

      const appendAndApply = (event: TaskEvent) =>
        Effect.gen(function* () {
          const persistedEvent = yield* eventAppender.append(taskId, event);
          const entity = yield* registry.lookup(event.taskId);
          if (entity !== undefined) {
            yield* entity.applyEvent(persistedEvent);
          }
          return persistedEvent;
        });

      const emitIo = ({ text, stream }: { text: string; stream: "stdout" | "stderr" }) => {
        const event: TaskEvent = {
          taskId,
          sequence: 0,
          timestamp: now(),
          type: stream === "stdout" ? "task:message_chunk" : "task:thought_chunk",
          payload: { text },
        };
        return appendAndApply(event).pipe(Effect.catch(() => Effect.void));
      };

      const hijackConsole = Effect.sync(() => {
        globalThis.console.log = (...args: ReadonlyArray<unknown>) => {
          ioWrites.push(
            Effect.runPromise(emitIo({ text: args.map(String).join(" "), stream: "stdout" })),
          );
        };
        globalThis.console.error = (...args: ReadonlyArray<unknown>) => {
          ioWrites.push(
            Effect.runPromise(emitIo({ text: args.map(String).join(" "), stream: "stderr" })),
          );
        };
      });

      const restoreConsole = Effect.sync(() => {
        globalThis.console.log = originalLog;
        globalThis.console.error = originalError;
      });

      const spawnChild = (options: TaskOptions) => {
        nextChild += 1;
        const childId = `${taskId}:child:${nextChild}`;

        const ready = Effect.runPromise(
          Effect.gen(function* () {
            const parent = yield* registry.lookup(taskId);
            if (parent === undefined) {
              return yield* Effect.fail(
                new ProgramHostError({ taskId, message: "Program task entity is not active" }),
              );
            }

            const childSpawned: TaskEvent = {
              taskId,
              sequence: 0,
              timestamp: now(),
              type: "task:child_spawned",
              payload: {
                childId,
                kind: "agent",
                label: `${options.agent.provider} (${options.agent.model})`,
                provider: options.agent.provider,
                model: options.agent.model,
              },
            };
            const persistedChildSpawned = yield* eventAppender.append(taskId, childSpawned);
            yield* parent.applyEvent(persistedChildSpawned);

            const child = yield* registry.getOrCreate(childId, taskId, taskId);
            const created: TaskEvent = {
              taskId: childId,
              sequence: 0,
              timestamp: now(),
              type: "task:created",
              payload: {
                parentId: taskId,
                kind: "agent",
              },
            };
            const persistedCreated = yield* eventAppender.append(taskId, created);
            yield* child.applyEvent(persistedCreated);
            return child;
          }),
        );

        const childOrFail = Effect.tryPromise({
          try: () => ready,
          catch: (error) =>
            new ProgramHostError({
              taskId,
              message: `Child task ${childId} was not created: ${String(error)}`,
            }),
        });

        const runChild = Effect.gen(function* () {
          const child = yield* childOrFail;
          yield* agentRuntime.runAgent(
            {
              taskId: childId,
              agent: options.agent,
              userInbox: child.userInbox,
              completionSignal: child.completionSignal,
            },
            (event) => appendAndApply(event).pipe(Effect.asVoid),
          );

          const snapshot = yield* child.snapshot;
          if (!isTerminalStatus(snapshot.status)) {
            const completed: TaskEvent = {
              taskId: childId,
              sequence: 0,
              timestamp: now(),
              type: "task:completed",
              payload: { result: snapshot.text },
            };
            const persistedCompleted = yield* eventAppender.append(taskId, completed);
            yield* child.applyEvent(persistedCompleted);
          }
        }).pipe(
          Effect.catch((error) =>
            childOrFail.pipe(
              Effect.flatMap((child) => {
                const failed: TaskEvent = {
                  taskId: childId,
                  sequence: 0,
                  timestamp: now(),
                  type: "task:failed",
                  payload: { error: String(error) },
                };
                return eventAppender
                  .append(taskId, failed)
                  .pipe(Effect.flatMap((persistedFailed) => child.applyEvent(persistedFailed)));
              }),
              Effect.catch(() => Effect.void),
            ),
          ),
        );

        const childFiber = Effect.runFork(runChild);
        let handleOperationTail: Promise<unknown> = Promise.resolve();
        const enqueueHandleOperation = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => {
          const run = handleOperationTail.then(() => Effect.runPromise(effect));
          handleOperationTail = run.catch(() => undefined);
          return run;
        };

        Effect.runFork(
          eventAppender.watch(taskId).pipe(
            Stream.filter(
              (event) =>
                event.taskId === childId &&
                (event.type === "task:cancelled" || event.type === "task:failed"),
            ),
            Stream.runHead,
            Effect.flatMap(() => Fiber.interrupt(childFiber)),
            Effect.catch(() => Effect.void),
            Effect.scoped,
          ),
        );

        const terminalError = (snapshot: TaskSnapshot): ProgramHostError =>
          new ProgramHostError({
            taskId: childId,
            message:
              snapshot.status === "cancelled"
                ? "Cancelled"
                : snapshot.status === "failed"
                  ? "Task failed"
                  : "Task completed",
          });

        const waitForTurn = (sequence: number): Effect.Effect<TurnResult, ProgramHostError> =>
          eventAppender
            .watch(taskId)
            .pipe(
              Stream.filter((event) => {
                if (event.taskId !== childId) {
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
                  return Effect.fail(
                    new ProgramHostError({ taskId: childId, message: "Turn stream ended" }),
                  );
                }

                const event = option.value;
                if (event.type === "task:turn_completed") {
                  return Effect.succeed(event.payload);
                }
                if (event.type === "task:cancelled") {
                  return Effect.fail(
                    new ProgramHostError({
                      taskId: childId,
                      message: event.payload.reason ?? "Cancelled",
                    }),
                  );
                }
                if (event.type === "task:failed") {
                  return Effect.fail(
                    new ProgramHostError({ taskId: childId, message: event.payload.error }),
                  );
                }
                return Effect.fail(
                  new ProgramHostError({ taskId: childId, message: "Unexpected turn event" }),
                );
              }),
            )
            .pipe(Effect.scoped);

        return makeTaskHandle(childId, {
          done: Effect.runPromise(childOrFail.pipe(Effect.flatMap((child) => child.await))),
          result: () =>
            Effect.runPromise(childOrFail.pipe(Effect.flatMap((child) => child.result))),
          snapshot: () =>
            Effect.runPromise(childOrFail.pipe(Effect.flatMap((child) => child.snapshot))),
          subscribe: () =>
            eventAppender.watch(taskId).pipe(Stream.filter((event) => event.taskId === childId)),
          send: (message) => {
            const queued = enqueueHandleOperation(
              Effect.gen(function* () {
                const child = yield* childOrFail;
                const snapshot = yield* child.snapshot;
                if (isTerminalStatus(snapshot.status)) {
                  return yield* Effect.fail(terminalError(snapshot));
                }

                const sequence = yield* child.reserveTurn;
                const fiber = yield* Effect.forkDetach(waitForTurn(sequence));
                yield* Effect.yieldNow;
                yield* child.send({
                  _tag: "SendMessage",
                  taskId: childId,
                  content: message,
                  sequence,
                });
                return fiber;
              }).pipe(
                Effect.catch((error) =>
                  Effect.fail(
                    error instanceof ProgramHostError
                      ? error
                      : new ProgramHostError({ taskId: childId, message: String(error) }),
                  ),
                ),
              ),
            );
            return queued.then((fiber) => Effect.runPromise(Fiber.join(fiber)));
          },
          complete: () => {
            void enqueueHandleOperation(
              childOrFail.pipe(
                Effect.flatMap((child) => child.send({ _tag: "CompleteTask", taskId: childId })),
              ),
            );
          },
          cancel: (reason) => {
            void enqueueHandleOperation(
              childOrFail.pipe(Effect.flatMap((child) => child.cancel(reason))),
            );
          },
        });
      };

      const context = {
        taskId,
        spawnChild,
      };

      const withContext = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
        Effect.acquireUseRelease(
          Effect.sync(() => enterProgramContext(context)),
          () => effect,
          (restore) => Effect.sync(restore),
        );

      const runModule = Effect.gen(function* () {
        const resolvedProgramPath = isAbsolute(programPath) ? programPath : resolve(programPath);
        const programUrl = pathToFileURL(resolvedProgramPath).href;
        const module = yield* withContext(
          Effect.tryPromise({
            try: () => import(programUrl),
            catch: (error) =>
              new ProgramHostError({
                taskId,
                message: `Program import failed: ${String(error)}`,
              }),
          }),
        );

        if (module !== null && typeof module === "object" && "default" in module) {
          const defaultExport = module.default;
          if (typeof defaultExport === "function") {
            const result = yield* Effect.tryPromise({
              try: () => Promise.resolve(defaultExport()),
              catch: (error) =>
                new ProgramHostError({
                  taskId,
                  message: `Program execution failed: ${String(error)}`,
                }),
            }).pipe(withContext);
            yield* Effect.tryPromise({
              try: () => Promise.all(ioWrites),
              catch: (error) =>
                new ProgramHostError({
                  taskId,
                  message: `Program IO capture failed: ${String(error)}`,
                }),
            });
            return result;
          }
        }

        yield* Effect.tryPromise({
          try: () => Promise.all(ioWrites),
          catch: (error) =>
            new ProgramHostError({
              taskId,
              message: `Program IO capture failed: ${String(error)}`,
            }),
        });

        return module;
      });

      return yield* Effect.acquireUseRelease(
        hijackConsole,
        () => runModule,
        () => restoreConsole,
      ).pipe(Effect.scoped);
    });

  return {
    runProgram,
  } satisfies ProgramHost;
});

export const ProgramHost = Context.Service<ProgramHost>("@mill/core/ProgramHost");

export const ProgramHostLive = Layer.effect(ProgramHost, makeProgramHost);
