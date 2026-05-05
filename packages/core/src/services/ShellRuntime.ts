import { Context, Data, Effect, Layer, Ref, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { ShellOptions, ShellOutput } from "../program.api";
import type { TaskEvent } from "../schemas/task-event";

export class ShellRuntimeError extends Data.TaggedError("ShellRuntimeError")<{
  readonly command: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ShellRuntimeInput {
  readonly taskId: string;
  readonly options: ShellOptions;
}

export type ShellRuntimeEmit = (event: TaskEvent) => Effect.Effect<void, unknown>;

export interface ShellRuntime {
  readonly runShell: (
    input: ShellRuntimeInput,
    emit: ShellRuntimeEmit,
  ) => Effect.Effect<ShellOutput, ShellRuntimeError>;
}

const now = (): string => new Date().toISOString();

const toShellRuntimeError =
  (options: ShellOptions) =>
  (cause: unknown): ShellRuntimeError =>
    cause instanceof ShellRuntimeError
      ? cause
      : new ShellRuntimeError({
          command: options.command,
          message: String(cause),
          cause,
        });

export const ShellRuntime = Context.Service<ShellRuntime>("@mill/core/ShellRuntime");

export const ShellRuntimeLive = Layer.effect(
  ShellRuntime,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;

    return ShellRuntime.of({
      runShell: ({ taskId, options }, emit) =>
        Effect.gen(function* () {
          const command = ChildProcess.make(options.command, options.args ?? [], {
            cwd: options.cwd,
            env: options.env,
            extendEnv: true,
            stdin:
              options.stdin === undefined
                ? "ignore"
                : Stream.succeed(options.stdin).pipe(Stream.encodeText),
            stdout: "pipe",
            stderr: "pipe",
          });
          const process = yield* spawner.spawn(command);

          const stdoutBuf = yield* Ref.make("");
          const stderrBuf = yield* Ref.make("");

          const drain = (
            stream: Stream.Stream<Uint8Array, unknown>,
            buffer: Ref.Ref<string>,
            type: "task:message_chunk" | "task:thought_chunk",
          ) =>
            stream.pipe(
              Stream.decodeText,
              Stream.tap((chunk) =>
                Effect.gen(function* () {
                  yield* Ref.update(buffer, (text) => text + chunk);
                  yield* emit({
                    taskId,
                    sequence: 0,
                    timestamp: now(),
                    type,
                    payload: { text: chunk },
                  }).pipe(Effect.catch(() => Effect.void));
                }),
              ),
              Stream.runDrain,
            );

          yield* Effect.all(
            [
              drain(process.stdout, stdoutBuf, "task:message_chunk"),
              drain(process.stderr, stderrBuf, "task:thought_chunk"),
            ],
            { concurrency: 2 },
          );

          const exitCode = Number(yield* process.exitCode);

          if (options.failOnNonZeroExit === true && exitCode !== 0) {
            return yield* Effect.fail(
              new ShellRuntimeError({
                command: options.command,
                message: `Exited with code ${exitCode}`,
              }),
            );
          }

          return {
            kind: "shell" as const,
            stdout: yield* Ref.get(stdoutBuf),
            stderr: yield* Ref.get(stderrBuf),
            exitCode,
          };
        }).pipe(
          Effect.scoped,
          Effect.catch((cause: unknown) => Effect.fail(toShellRuntimeError(options)(cause))),
        ),
    });
  }),
);
