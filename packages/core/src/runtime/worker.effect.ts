import * as FileSystem from "@effect/platform/FileSystem";
import { Clock, Effect } from "effect";
import type { RunId, RunSyncOutput } from "../domain/run.schema";
import {
  ProgramExecutionError,
  type MillEngine,
  type RunSyncInput,
} from "../internal/engine.effect";
import { PersistenceError, RunNotFoundError } from "../internal/run-store.effect";
import { LifecycleInvariantError } from "../internal/lifecycle-guard.effect";

export interface DetachedWorkerInput {
  readonly engine: MillEngine;
  readonly runId: RunId;
  readonly programPath: string;
  readonly runsDirectory: string;
  readonly executeProgram: RunSyncInput["executeProgram"];
}

const isTerminalStatus = (status: RunSyncOutput["run"]["status"]): boolean =>
  status === "complete" || status === "failed" || status === "cancelled";

const normalizePath = (path: string): string => {
  if (path.length <= 1) {
    return path;
  }

  return path.endsWith("/") ? path.slice(0, -1) : path;
};

const joinPath = (base: string, child: string): string =>
  normalizePath(base) === "/" ? `/${child}` : `${normalizePath(base)}/${child}`;

const toIsoTimestamp = Effect.map(Clock.currentTimeMillis, (millis) =>
  new Date(millis).toISOString(),
);

const appendWorkerLog = (
  logFilePath: string,
  message: string,
): Effect.Effect<void, PersistenceError> =>
  Effect.gen(function* () {
    const timestamp = yield* toIsoTimestamp;
    const fileSystem = yield* FileSystem.FileSystem;
    const logsDirectory = logFilePath.slice(0, logFilePath.lastIndexOf("/"));

    yield* Effect.mapError(
      fileSystem.makeDirectory(logsDirectory, { recursive: true }),
      (error) =>
        new PersistenceError({
          path: logsDirectory,
          message: String(error),
        }),
    );

    yield* Effect.mapError(
      fileSystem.writeFileString(logFilePath, `${timestamp} ${message}\n`, { flag: "a" }),
      (error) =>
        new PersistenceError({
          path: logFilePath,
          message: String(error),
        }),
    );
  });

export const runDetachedWorker = (
  input: DetachedWorkerInput,
): Effect.Effect<
  RunSyncOutput,
  RunNotFoundError | PersistenceError | ProgramExecutionError | LifecycleInvariantError
> =>
  Effect.gen(function* () {
    const submittedRun = yield* input.engine.submit({
      runId: input.runId,
      programPath: input.programPath,
    });

    const runDirectory =
      submittedRun.paths.runDir.length > 0
        ? submittedRun.paths.runDir
        : joinPath(input.runsDirectory, input.runId);
    const workerLogPath = joinPath(runDirectory, "logs/worker.log");

    yield* appendWorkerLog(workerLogPath, `worker:start runId=${input.runId}`);

    if (isTerminalStatus(submittedRun.status)) {
      const existingResult = yield* input.engine.result(input.runId);

      if (existingResult !== undefined) {
        yield* appendWorkerLog(
          workerLogPath,
          `worker:terminal-noop runId=${input.runId} status=${submittedRun.status}`,
        );

        return {
          run: submittedRun,
          result: existingResult,
        } satisfies RunSyncOutput;
      }
    }

    const runOutput = yield* Effect.tapError(
      input.engine.runSync({
        runId: input.runId,
        programPath: input.programPath,
        executeProgram: input.executeProgram,
      }),
      (error) =>
        appendWorkerLog(
          workerLogPath,
          `worker:failed runId=${input.runId} message=${String(error)}`,
        ),
    );

    yield* appendWorkerLog(workerLogPath, `worker:complete runId=${input.runId}`);

    return runOutput;
  });
