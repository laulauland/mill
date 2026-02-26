import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunRecord, RunStatus } from "./registry.js";
import type { ExecutionResult, RunSummary, UsageStats } from "./types.js";

/**
 * Filesystem scanner for standalone --mill mode.
 *
 * Source of truth: canonical mill run store (~/.mill/runs).
 * We only surface runs created by pi-mill (metadata.source === "pi-mill").
 */

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
    return Date.now();
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
};

const readJson = <T>(filePath: string): T | undefined => {
  try {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
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
      artifacts: fs.existsSync(resultPath) ? [runJsonPath, resultPath] : [runJsonPath],
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
  return path.join(os.homedir(), ".mill", "runs");
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
  const records: Omit<RunRecord, "promise" | "abort">[] = [];

  const runDirs = listRunDirs(runsBase);

  for (const runDir of runDirs) {
    const parsed = parseCanonicalRun(runDir, sessionDirName);
    if (parsed) {
      records.push(parsed);
    }
  }

  return records;
}

/**
 * Cancel a subagent by reading its PID file and sending SIGTERM (then SIGKILL after 3s).
 * Returns true if the signal was sent, false if the PID file was missing or the process was already gone.
 */
export function cancelByPidFile(outputDir: string, taskId: string): boolean {
  const pidPath = path.join(outputDir, `${taskId}.pid`);
  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, "SIGTERM");
    setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }, 3000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cancel a run by reading run.json from the selected artifacts directory.
 * Supports canonical mill run.json (`id`) and legacy pi-mill marker run.json (`runId`).
 */
export function cancelRunByPidFiles(artifactsDir: string): number {
  let cancelled = 0;

  try {
    const runJsonPath = path.join(artifactsDir, "run.json");
    if (fs.existsSync(runJsonPath)) {
      const data = readJson<CanonicalRunJson>(runJsonPath);
      const runId =
        data && typeof data.id === "string"
          ? data.id
          : data && typeof data.runId === "string"
            ? data.runId
            : undefined;

      if (runId && runId.length > 0) {
        const command = data?.mill?.command?.trim() || "mill";
        const args = [...(data?.mill?.args ?? []), "cancel", runId];

        if (data?.mill?.runsDir && data.mill.runsDir.trim().length > 0) {
          args.push("--runs-dir", data.mill.runsDir);
        }

        const result = spawnSync(command, args, {
          stdio: "ignore",
          shell: false,
        });

        if (result.status === 0) {
          cancelled++;
          return cancelled;
        }
      }
    }
  } catch {
    // fall through to PID fallback
  }

  const sessionsDir = path.join(artifactsDir, "sessions");
  try {
    if (!fs.existsSync(sessionsDir)) return cancelled;
    for (const entry of fs.readdirSync(sessionsDir)) {
      if (!entry.endsWith(".pid")) continue;
      const taskId = entry.replace(/\.pid$/, "");
      if (cancelByPidFile(sessionsDir, taskId)) cancelled++;
    }
  } catch {
    // ignore fallback failures
  }

  return cancelled;
}

/** List canonical run directories under the runs base. */
function listRunDirs(runsBase: string): string[] {
  try {
    if (!fs.existsSync(runsBase)) return [];

    return fs
      .readdirSync(runsBase)
      .map((entry) => path.join(runsBase, entry))
      .filter((entryPath) => {
        try {
          return fs.statSync(entryPath).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}
