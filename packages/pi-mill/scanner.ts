import { Data, Effect, Exit } from "effect";
import {
  homeDirectory,
  isDirectory,
  path,
  pathExists,
  provideFileSystem,
  readDirectory,
  readTextFile,
} from "./platform.adapter.js";
import { now } from "./clock.js";
import { parseJson } from "./json.codec.js";
import type { RunRecord, RunStatus } from "./registry.js";
import type { ExecutionResult, RunSummary, UsageStats } from "./types.js";

/**
 * Filesystem scanner for standalone --mill mode.
 *
 * Source of truth: canonical mill run store (~/.mill/runs).
 * We only surface runs created by pi-mill (metadata.source === "pi-mill").
 */

export class ScannerError extends Data.TaggedError("ScannerError")<{
  readonly operation: "readJson" | "scanRuns" | "cancelPid" | "cancelRun" | "listRunDirs";
  readonly path?: string;
  readonly pid?: number;
  readonly cause: unknown;
}> {}

/** Convert a cwd (or session path) to the stable session directory key. */
export function cwdToSessionDir(cwd: string): string {
  const baseName = path.basename(cwd);
  if (baseName.startsWith("--") && baseName.endsWith("--")) {
    return baseName;
  }

  const normalized = cwd.startsWith("/") ? cwd.slice(1) : cwd;
  return `--${normalized.replace(/\//g, "-")}--`;
}

interface CanonicalRunPaths {
  runDir?: string;
  runFile?: string;
  eventsFile?: string;
  resultFile?: string;
}

interface CanonicalRunJson {
  id?: string;
  runId?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, string>;
  paths?: CanonicalRunPaths;
  mill?: {
    command?: string;
    args?: string[];
    runsDir?: string;
  };
}

interface CanonicalSpawnJson {
  agent?: string;
  model?: string;
  exitCode?: number;
  text?: string;
  sessionRef?: string;
  stopReason?: string;
  errorMessage?: string;
}

interface CanonicalResultJson {
  status?: string;
  errorMessage?: string;
  spawns?: ReadonlyArray<CanonicalSpawnJson>;
}

const DEFAULT_USAGE: UsageStats = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
};

const normalizeRunStatus = (status: string | undefined): RunStatus => {
  switch (status) {
    case "done":
    case "complete":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "running":
    case "pending":
    default:
      return "running";
  }
};

const toEpochMillis = (value: string | undefined): number => {
  if (value === undefined) {
    return now();
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : now();
};

const readJsonEffect = <T>(filePath: string): Effect.Effect<T | undefined, ScannerError, never> =>
  provideFileSystem(
    Effect.gen(function* () {
      const exists = yield* pathExists(filePath);
      if (!exists) return undefined;
      const raw = yield* readTextFile(filePath);
      return parseJson(raw) as T;
    }),
  ).pipe(
    Effect.mapError((cause) => new ScannerError({ operation: "readJson", path: filePath, cause })),
  );

const readJson = <T>(filePath: string): T | undefined => {
  const decoded = Effect.runSyncExit(readJsonEffect<T>(filePath));
  if (Exit.isFailure(decoded)) {
    console.warn(`Unable to read pi-mill run metadata from ${filePath}.`);
    return undefined;
  }
  return decoded.value;
};

const toExecutionResults = (
  spawns: ReadonlyArray<CanonicalSpawnJson> | undefined,
  fallbackTask: string,
): ExecutionResult[] => {
  if (!Array.isArray(spawns)) {
    return [];
  }

  return spawns.map((spawn, index) => ({
    taskId: `spawn-${index + 1}`,
    agent: typeof spawn.agent === "string" && spawn.agent.length > 0 ? spawn.agent : "unknown",
    task: fallbackTask,
    exitCode: typeof spawn.exitCode === "number" ? spawn.exitCode : 0,
    messages: [],
    stderr: "",
    usage: DEFAULT_USAGE,
    model: spawn.model,
    stopReason: spawn.stopReason,
    errorMessage: spawn.errorMessage,
    text: spawn.text ?? "",
    sessionPath: spawn.sessionRef,
  }));
};

const parseCanonicalRun = (
  runDir: string,
  sessionDirName?: string,
): Omit<RunRecord, "promise" | "abort"> | undefined => {
  const runJsonPath = path.join(runDir, "run.json");
  const runJson = readJson<CanonicalRunJson>(runJsonPath);

  if (!runJson) {
    return undefined;
  }

  const runId =
    typeof runJson.id === "string"
      ? runJson.id
      : typeof runJson.runId === "string"
        ? runJson.runId
        : undefined;

  if (!runId || runId.length === 0) {
    return undefined;
  }

  const metadata = runJson.metadata ?? {};
  const source = metadata.source;

  if (source !== "pi-mill") {
    return undefined;
  }

  if (sessionDirName !== undefined) {
    const sessionKey = metadata.piSessionKey;
    if (typeof sessionKey === "string" && sessionKey.length > 0 && sessionKey !== sessionDirName) {
      return undefined;
    }
  }

  const resultPath =
    typeof runJson.paths?.resultFile === "string" && runJson.paths.resultFile.length > 0
      ? runJson.paths.resultFile
      : path.join(runDir, "result.json");
  const resultJson = readJson<CanonicalResultJson>(resultPath);

  const status = normalizeRunStatus(runJson.status ?? resultJson?.status);
  const startedAt = toEpochMillis(runJson.createdAt);
  const completedAt = status === "running" ? undefined : toEpochMillis(runJson.updatedAt);

  const fallbackTask = metadata.parentTask ?? metadata.programTask ?? metadata.parentTaskId ?? "";
  const results = toExecutionResults(resultJson?.spawns, fallbackTask);

  const errorMessage = resultJson?.errorMessage;
  const resultExists = Effect.runSyncExit(provideFileSystem(pathExists(resultPath)));
  const artifacts =
    Exit.isSuccess(resultExists) && resultExists.value ? [runJsonPath, resultPath] : [runJsonPath];

  const summary: RunSummary = {
    runId,
    status,
    results,
    error:
      status === "failed"
        ? {
            code: "RUNTIME",
            message: errorMessage ?? "Run failed.",
            recoverable: false,
          }
        : undefined,
    metadata,
    observability: {
      status,
      events: [],
      artifacts,
      artifactsDir: runDir,
      startedAt,
      endedAt: completedAt,
    },
  };

  return {
    runId,
    status,
    summary,
    startedAt,
    completedAt,
    acknowledged: true,
    task: metadata.programTask ?? metadata.parentTask ?? metadata.parentTaskId,
  };
};

/** Get the canonical mill runs base directory. */
export function getRunsBase(): string {
  return path.join(homeDirectory(), ".mill", "runs");
}

/** Backward-compatible alias for existing imports. */
export const getSessionsBase = getRunsBase;

/**
 * Scan canonical mill runs and return pi-mill owned records.
 * Optional sessionDirName filters by metadata.piSessionKey when present.
 */
export function scanRuns(
  runsBase: string,
  sessionDirName?: string,
): Omit<RunRecord, "promise" | "abort">[] {
  const scanned = Effect.runSyncExit(scanRunsEffect(runsBase, sessionDirName));
  if (Exit.isFailure(scanned)) {
    console.warn(`Unable to scan pi-mill runs from ${runsBase}.`);
    return [];
  }
  return scanned.value;
}

export const scanRunsEffect = (
  runsBase: string,
  sessionDirName?: string,
): Effect.Effect<Omit<RunRecord, "promise" | "abort">[], ScannerError, never> =>
  Effect.gen(function* () {
    const records: Omit<RunRecord, "promise" | "abort">[] = [];
    const runDirs = yield* listRunDirsEffect(runsBase);

    for (const runDir of runDirs) {
      const parsed = parseCanonicalRun(runDir, sessionDirName);
      if (parsed) {
        records.push(parsed);
      }
    }

    return records;
  });

/**
 * Cancel a subagent by reading its PID file and sending SIGTERM (then SIGKILL after 3s).
 * Returns true if the signal was sent, false if the PID file was missing or the process was already gone.
 */
export function cancelByPidFile(outputDir: string, taskId: string): boolean {
  const pidPath = path.join(outputDir, `${taskId}.pid`);
  const cancelled = Effect.runSyncExit(cancelByPidFileEffect(pidPath));
  if (Exit.isFailure(cancelled)) {
    console.warn(`Unable to cancel process described by ${pidPath}.`);
    return false;
  }
  return cancelled.value;
}

const cancelByPidFileEffect = (pidPath: string): Effect.Effect<boolean, ScannerError, never> =>
  provideFileSystem(
    Effect.gen(function* () {
      const exists = yield* pathExists(pidPath);
      if (!exists) return false;
      const pid = Number.parseInt((yield* readTextFile(pidPath)).trim(), 10);
      if (Number.isNaN(pid)) return false;
      process.kill(pid, "SIGTERM");
      setTimeout(() => {
        const killed = Effect.runSyncExit(
          Effect.sync(() => {
            process.kill(pid, "SIGKILL");
          }),
        );
        if (Exit.isFailure(killed)) {
          console.warn(`Unable to SIGKILL child process ${pid}.`);
        }
      }, 3000);
      return true;
    }),
  ).pipe(
    Effect.mapError((cause) => new ScannerError({ operation: "cancelPid", path: pidPath, cause })),
  );

/**
 * Cancel a run by reading run.json from the selected artifacts directory.
 * Supports canonical mill run.json (`id`) and legacy pi-mill marker run.json (`runId`).
 */
export function cancelRunByPidFiles(artifactsDir: string): number {
  const runJsonPath = path.join(artifactsDir, "run.json");
  const runJsonRead = Bun.spawnSync(["cat", runJsonPath]);

  if (runJsonRead.exitCode === 0) {
    const data = parseJson(new TextDecoder().decode(runJsonRead.stdout)) as CanonicalRunJson;
    const runId =
      typeof data.id === "string"
        ? data.id
        : typeof data.runId === "string"
          ? data.runId
          : undefined;

    if (runId && runId.length > 0) {
      const command = data.mill?.command?.trim() || "mill";
      const args = [...(data.mill?.args ?? []), "cancel", runId];
      const configuredRunsDir = data.mill?.runsDir?.trim();
      const isCanonicalRunJson = typeof data.id === "string" && data.id.length > 0;
      const inferredRunsDir = isCanonicalRunJson ? path.dirname(artifactsDir) : undefined;
      const runsDir =
        configuredRunsDir && configuredRunsDir.length > 0 ? configuredRunsDir : inferredRunsDir;

      if (runsDir && runsDir.length > 0) {
        args.push("--runs-dir", runsDir);
      }

      const cancelProcess = Bun.spawnSync([command, ...args]);
      return cancelProcess.exitCode === 0 ? 1 : 0;
    }
  }

  Effect.runFork(cancelRunByPidFilesEffect(artifactsDir));
  return 0;
}

const cancelRunByPidFilesEffect = (
  artifactsDir: string,
): Effect.Effect<number, ScannerError, never> =>
  Effect.gen(function* () {
    const runJsonPath = path.join(artifactsDir, "run.json");
    const data = yield* readJsonEffect<CanonicalRunJson>(runJsonPath);
    const runId =
      data && typeof data.id === "string"
        ? data.id
        : data && typeof data.runId === "string"
          ? data.runId
          : undefined;

    if (runId && runId.length > 0) {
      const command = data?.mill?.command?.trim() || "mill";
      const args = [...(data?.mill?.args ?? []), "cancel", runId];
      const configuredRunsDir = data?.mill?.runsDir?.trim();
      const isCanonicalRunJson = typeof data?.id === "string" && data.id.length > 0;
      const inferredRunsDir = isCanonicalRunJson ? path.dirname(artifactsDir) : undefined;
      const runsDir =
        configuredRunsDir && configuredRunsDir.length > 0 ? configuredRunsDir : inferredRunsDir;

      if (runsDir && runsDir.length > 0) {
        args.push("--runs-dir", runsDir);
      }

      Bun.spawn([command, ...args], { stdout: "ignore", stderr: "ignore" });
      return 1;
    }

    const sessionsDir = path.join(artifactsDir, "sessions");
    const sessionsExist = yield* provideFileSystem(pathExists(sessionsDir));
    if (!sessionsExist) return 0;
    const entries = yield* provideFileSystem(readDirectory(sessionsDir));
    let cancelledCount = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".pid")) continue;
      const taskId = entry.replace(/\.pid$/, "");
      const cancelled = yield* cancelByPidFileEffect(path.join(sessionsDir, `${taskId}.pid`));
      if (cancelled) {
        cancelledCount += 1;
      }
    }
    return cancelledCount;
  }).pipe(
    Effect.mapError(
      (cause) => new ScannerError({ operation: "cancelRun", path: artifactsDir, cause }),
    ),
  );

/** List canonical run directories under the runs base. */
function listRunDirsEffect(runsBase: string): Effect.Effect<string[], ScannerError, never> {
  return provideFileSystem(
    Effect.gen(function* () {
      const exists = yield* pathExists(runsBase);
      if (!exists) return [];

      const entries = yield* readDirectory(runsBase);
      const directories: string[] = [];
      for (const entry of entries) {
        const entryPath = path.join(runsBase, entry);
        if (yield* isDirectory(entryPath)) {
          directories.push(entryPath);
        }
      }
      return directories;
    }),
  ).pipe(
    Effect.mapError(
      (cause) => new ScannerError({ operation: "listRunDirs", path: runsBase, cause }),
    ),
  );
}
