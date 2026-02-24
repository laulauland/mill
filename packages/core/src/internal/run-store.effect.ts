import * as FileSystem from "@effect/platform/FileSystem";
import { Data, Effect } from "effect";
import { decodeMillEventJson, encodeMillEventJson, type MillEvent } from "../domain/event.schema";
import {
  decodeRunId,
  decodeRunRecordJson,
  decodeRunResultJson,
  type RunId,
  type RunRecord,
  type RunResult,
} from "../domain/run.schema";
import { LifecycleInvariantError, ensureRunStatusTransition } from "./lifecycle-guard.effect";

export class RunNotFoundError extends Data.TaggedError("RunNotFoundError")<{ runId: string }> {}

export class PersistenceError extends Data.TaggedError("PersistenceError")<{
  path: string;
  message: string;
}> {}

export interface CreateRunInput {
  readonly runId: RunId;
  readonly programPath: string;
  readonly driver: string;
  readonly executor?: string;
  readonly timestamp: string;
  readonly status?: RunRecord["status"];
}

export interface RunStore {
  readonly create: (input: CreateRunInput) => Effect.Effect<RunRecord, PersistenceError>;
  readonly appendEvent: (runId: RunId, event: MillEvent) => Effect.Effect<void, PersistenceError>;
  readonly readEvents: (
    runId: RunId,
  ) => Effect.Effect<ReadonlyArray<MillEvent>, RunNotFoundError | PersistenceError>;
  readonly setStatus: (
    runId: RunId,
    status: RunRecord["status"],
    timestamp: string,
  ) => Effect.Effect<RunRecord, RunNotFoundError | PersistenceError | LifecycleInvariantError>;
  readonly setResult: (
    runId: RunId,
    result: RunResult,
    timestamp: string,
  ) => Effect.Effect<void, RunNotFoundError | PersistenceError | LifecycleInvariantError>;
  readonly getRun: (runId: RunId) => Effect.Effect<RunRecord, RunNotFoundError | PersistenceError>;
  readonly getResult: (
    runId: RunId,
  ) => Effect.Effect<RunResult | undefined, RunNotFoundError | PersistenceError>;
  readonly listRuns: (
    status?: RunRecord["status"],
  ) => Effect.Effect<ReadonlyArray<RunRecord>, PersistenceError>;
}

export interface MakeRunStoreInput {
  readonly runsDirectory: string;
}

const joinPath = (base: string, child: string): string =>
  base.endsWith("/") ? `${base}${child}` : `${base}/${child}`;

const toMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const mapPersistenceError = (path: string) =>
  Effect.mapError((error: unknown) => new PersistenceError({ path, message: toMessage(error) }));

const buildPaths = (runsDirectory: string, runId: RunId): RunRecord["paths"] => {
  const runDir = joinPath(runsDirectory, runId);

  return {
    runDir,
    runFile: joinPath(runDir, "run.json"),
    eventsFile: joinPath(runDir, "events.ndjson"),
    resultFile: joinPath(runDir, "result.json"),
  };
};

const storeSetStatus = (
  runsDirectory: string,
  runId: RunId,
  status: RunRecord["status"],
  timestamp: string,
): Effect.Effect<RunRecord, RunNotFoundError | PersistenceError | LifecycleInvariantError> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const currentRun = yield* storeGetRun(runsDirectory, runId);

    yield* ensureRunStatusTransition(runId, currentRun.status, status);

    const nextRun: RunRecord = {
      ...currentRun,
      status,
      updatedAt: timestamp,
    };

    yield* mapPersistenceError(currentRun.paths.runFile)(
      fileSystem.writeFileString(currentRun.paths.runFile, `${JSON.stringify(nextRun, null, 2)}\n`),
    );

    return nextRun;
  });

export const makeRunStore = (input: MakeRunStoreInput): RunStore => ({
  create: (createInput) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = buildPaths(input.runsDirectory, createInput.runId);
      const runRecord: RunRecord = {
        id: createInput.runId,
        status: createInput.status ?? "running",
        programPath: createInput.programPath,
        driver: createInput.driver,
        executor: createInput.executor ?? "direct",
        createdAt: createInput.timestamp,
        updatedAt: createInput.timestamp,
        paths,
      };

      yield* mapPersistenceError(paths.runDir)(
        fileSystem.makeDirectory(paths.runDir, { recursive: true }),
      );
      yield* mapPersistenceError(paths.runFile)(
        fileSystem.writeFileString(paths.runFile, `${JSON.stringify(runRecord, null, 2)}\n`),
      );
      yield* mapPersistenceError(paths.eventsFile)(
        fileSystem.writeFileString(paths.eventsFile, ""),
      );

      return runRecord;
    }),

  appendEvent: (runId, event) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = buildPaths(input.runsDirectory, runId);

      yield* mapPersistenceError(paths.eventsFile)(
        fileSystem.writeFileString(paths.eventsFile, `${encodeMillEventJson(event)}\n`, {
          flag: "a",
        }),
      );
    }),

  readEvents: (runId) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const runRecord = yield* storeGetRun(input.runsDirectory, runId);
      const eventsContent = yield* mapPersistenceError(runRecord.paths.eventsFile)(
        fileSystem.readFileString(runRecord.paths.eventsFile, "utf-8"),
      );

      const lines = eventsContent
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      return yield* Effect.forEach(lines, (line) =>
        Effect.mapError(
          decodeMillEventJson(line),
          (error) =>
            new PersistenceError({
              path: runRecord.paths.eventsFile,
              message: toMessage(error),
            }),
        ),
      );
    }),

  setStatus: (runId, status, timestamp) =>
    storeSetStatus(input.runsDirectory, runId, status, timestamp),

  setResult: (runId, result, timestamp) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const runRecord = yield* storeGetRun(input.runsDirectory, runId);

      yield* mapPersistenceError(runRecord.paths.resultFile)(
        fileSystem.writeFileString(
          runRecord.paths.resultFile,
          `${JSON.stringify(result, null, 2)}\n`,
        ),
      );

      yield* storeSetStatus(input.runsDirectory, runId, result.status, timestamp);
    }),

  getRun: (runId) => storeGetRun(input.runsDirectory, runId),

  getResult: (runId) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const runRecord = yield* storeGetRun(input.runsDirectory, runId);
      const hasResult = yield* mapPersistenceError(runRecord.paths.resultFile)(
        fileSystem.exists(runRecord.paths.resultFile),
      );

      if (!hasResult) {
        return undefined;
      }

      const resultContent = yield* mapPersistenceError(runRecord.paths.resultFile)(
        fileSystem.readFileString(runRecord.paths.resultFile, "utf-8"),
      );

      return yield* Effect.mapError(
        decodeRunResultJson(resultContent),
        (error) =>
          new PersistenceError({
            path: runRecord.paths.resultFile,
            message: toMessage(error),
          }),
      );
    }),

  listRuns: (status) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const runsDirectoryExists = yield* mapPersistenceError(input.runsDirectory)(
        fileSystem.exists(input.runsDirectory),
      );

      if (!runsDirectoryExists) {
        return [];
      }

      const runDirectories = yield* mapPersistenceError(input.runsDirectory)(
        fileSystem.readDirectory(input.runsDirectory),
      );

      const loadedRuns = yield* Effect.forEach(
        runDirectories,
        (runDirectory) =>
          Effect.gen(function* () {
            const decodedRunId = yield* Effect.either(decodeRunId(runDirectory));

            if (decodedRunId._tag === "Left") {
              return undefined;
            }

            const maybeRun = yield* Effect.either(
              storeGetRun(input.runsDirectory, decodedRunId.right),
            );

            if (maybeRun._tag === "Left") {
              return undefined;
            }

            return maybeRun.right;
          }),
        {
          concurrency: "unbounded",
        },
      );

      const filteredRuns = loadedRuns
        .filter((run): run is RunRecord => run !== undefined)
        .filter((run) => (status === undefined ? true : run.status === status))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

      return filteredRuns;
    }),
});

const storeGetRun = (
  runsDirectory: string,
  runId: RunId,
): Effect.Effect<RunRecord, RunNotFoundError | PersistenceError> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = buildPaths(runsDirectory, runId);
    const exists = yield* mapPersistenceError(paths.runFile)(fileSystem.exists(paths.runFile));

    if (!exists) {
      return yield* Effect.fail(new RunNotFoundError({ runId }));
    }

    const runFileContent = yield* mapPersistenceError(paths.runFile)(
      fileSystem.readFileString(paths.runFile, "utf-8"),
    );

    const runRecord = yield* Effect.mapError(
      decodeRunRecordJson(runFileContent),
      (error) =>
        new PersistenceError({
          path: paths.runFile,
          message: toMessage(error),
        }),
    );

    return runRecord;
  });
