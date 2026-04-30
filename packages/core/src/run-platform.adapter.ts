import { Data, Effect, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcess } from "effect/unstable/process";

export class RunPlatformFileError extends Data.TaggedError("RunPlatformFileError")<{
  readonly path: string;
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class RunPlatformProcessError extends Data.TaggedError("RunPlatformProcessError")<{
  readonly operation: string;
  readonly pid?: number;
  readonly cause: unknown;
}> {}

const decodeBytes = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const collectStdout = (
  command: ReturnType<typeof ChildProcess.make>,
): Effect.Effect<string, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* command;
      const chunks = yield* Stream.runCollect(handle.stdout);
      const exitCode = yield* handle.exitCode;

      if (Number(exitCode) !== 0) {
        return yield* Effect.fail(
          new RunPlatformProcessError({
            operation: "collectStdout",
            cause: `exitCode=${exitCode}`,
          }),
        );
      }

      return Array.from(chunks).map(decodeBytes).join("");
    }),
  );

export const randomUuid = (): Effect.Effect<string> =>
  Effect.sync(() => globalThis.crypto.randomUUID());

export const appendTextFile = (
  path: string,
  content: string,
): Effect.Effect<void, RunPlatformFileError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .writeFileString(path, content, { flag: "a" })
      .pipe(
        Effect.mapError(
          (cause) => new RunPlatformFileError({ path, operation: "appendTextFile", cause }),
        ),
      );
  });

export const ensureDirectory = (
  path: string,
): Effect.Effect<void, RunPlatformFileError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .makeDirectory(path, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new RunPlatformFileError({ path, operation: "ensureDirectory", cause }),
        ),
      );
  });

export const readTextFile = (
  path: string,
): Effect.Effect<string, RunPlatformFileError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem
      .readFileString(path, "utf-8")
      .pipe(
        Effect.mapError(
          (cause) => new RunPlatformFileError({ path, operation: "readTextFile", cause }),
        ),
      );
  });

export const removePath = (
  path: string,
): Effect.Effect<void, RunPlatformFileError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .remove(path, { force: true })
      .pipe(
        Effect.mapError(
          (cause) => new RunPlatformFileError({ path, operation: "removePath", cause }),
        ),
      );
  });

export const writeTextFile = (
  path: string,
  content: string,
): Effect.Effect<void, RunPlatformFileError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .writeFileString(path, content)
      .pipe(
        Effect.mapError(
          (cause) => new RunPlatformFileError({ path, operation: "writeTextFile", cause }),
        ),
      );
  });

export const readProcessCommand = (
  pid: number,
): Effect.Effect<string | undefined, RunPlatformProcessError> =>
  collectStdout(
    ChildProcess.make("ps", ["-o", "command=", "-p", String(pid)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    }),
  ).pipe(
    Effect.map((output) => {
      const commandLine = output.trim();
      return commandLine.length > 0 ? commandLine : undefined;
    }),
    Effect.mapError(
      (cause) => new RunPlatformProcessError({ operation: "readProcessCommand", pid, cause }),
    ),
  );

export const readProcessTable = (): Effect.Effect<
  ReadonlyArray<{ pid: number; ppid: number }>,
  RunPlatformProcessError
> =>
  collectStdout(
    ChildProcess.make("ps", ["-ax", "-o", "pid=,ppid="], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    }),
  ).pipe(
    Effect.map((stdout) =>
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.split(/\s+/))
        .map(([pidText, ppidText]) => ({
          pid: Number.parseInt(pidText ?? "", 10),
          ppid: Number.parseInt(ppidText ?? "", 10),
        }))
        .filter((entry) => Number.isInteger(entry.pid) && Number.isInteger(entry.ppid)),
    ),
    Effect.catchTag("RunPlatformProcessError", (error) => Effect.fail(error)),
    Effect.mapError(
      (cause) => new RunPlatformProcessError({ operation: "readProcessTable", cause }),
    ),
  );
