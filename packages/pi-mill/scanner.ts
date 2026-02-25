import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { RunRecord, RunStatus } from "./registry.js";
import type { RunSummary, ExecutionResult, UsageStats } from "./types.js";

/**
 * Filesystem scanner for standalone --mill mode.
 * Reads run.json files from ~/.pi/agent/sessions/<session-dir>/.mill/<run-id>/run.json
 */

/** Convert a cwd path to the session directory name pi uses. */
export function cwdToSessionDir(cwd: string): string {
  // /Users/foo/Code/project → --Users-foo-Code-project--
  return "--" + cwd.slice(1).replace(/\//g, "-") + "--";
}

/**
 * Shape of run.json on disk (written by writeRunJson in index.ts).
 * Convention: status="running" is advisory; scanner reconciles it against canonical mill status.
 */
interface RunJsonData {
  runId: string;
  status?: string;
  task?: string;
  startedAt?: number;
  completedAt?: number;
  reconciledAt?: number;
  mill?: {
    command?: string;
    args?: string[];
    runsDir?: string;
  };
  results?: Array<{
    agent: string;
    task: string;
    model?: string;
    exitCode: number;
    text: string;
    sessionPath?: string;
    usage?: UsageStats;
    stopReason?: string;
    errorMessage?: string;
  }>;
  error?: { code: string; message: string; recoverable: boolean };
}

const parseJsonObjectFromText = (text: string): Record<string, unknown> | undefined => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reverse();

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }

  return undefined;
};

const normalizeRunStatus = (status: string | undefined): RunStatus => {
  if (status === undefined) {
    return "done";
  }

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
      return "running";
    default:
      return "running";
  }
};

const extractStatusFromMillPayload = (payload: Record<string, unknown>): string | undefined => {
  const direct = payload.status;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }

  const nestedRun = payload.run;
  if (typeof nestedRun === "object" && nestedRun !== null) {
    const nestedStatus = (nestedRun as { status?: unknown }).status;
    if (typeof nestedStatus === "string" && nestedStatus.length > 0) {
      return nestedStatus;
    }
  }

  return undefined;
};

const reconcileRunningStatus = (runJsonPath: string, data: RunJsonData): RunJsonData => {
  if (normalizeRunStatus(data.status) !== "running") {
    return data;
  }

  if (typeof data.runId !== "string" || data.runId.length === 0) {
    return data;
  }

  const command = data.mill?.command?.trim() || "mill";
  const args = [...(data.mill?.args ?? []), "status", data.runId, "--json"];

  if (data.mill?.runsDir && data.mill.runsDir.trim().length > 0) {
    args.push("--runs-dir", data.mill.runsDir);
  }

  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    return data;
  }

  const payload = parseJsonObjectFromText(`${result.stdout}\n${result.stderr}`);
  if (!payload) {
    return data;
  }

  const canonicalStatus = normalizeRunStatus(extractStatusFromMillPayload(payload));

  if (canonicalStatus === "running") {
    return data;
  }

  const reconciled: RunJsonData = {
    ...data,
    status: canonicalStatus,
    completedAt: data.completedAt ?? Date.now(),
    reconciledAt: Date.now(),
  };

  try {
    fs.writeFileSync(runJsonPath, `${JSON.stringify(reconciled, null, 2)}\n`, "utf-8");
  } catch {
    // best effort persistence; return reconciled in-memory snapshot regardless
  }

  return reconciled;
};

/** Parse a single run.json into a RunRecord (without promise/abort). */
function parseRunJson(
  data: RunJsonData,
  artifactsDir: string,
): Omit<RunRecord, "promise" | "abort"> {
  const status: RunStatus = normalizeRunStatus(data.status);
  const results: ExecutionResult[] = (data.results ?? []).map((r) => ({
    taskId: "",
    agent: r.agent ?? "unknown",
    task: r.task ?? "",
    exitCode: r.exitCode ?? -1,
    messages: [],
    stderr: "",
    usage: r.usage ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: r.model,
    stopReason: r.stopReason,
    errorMessage: r.errorMessage,
    text: r.text ?? "",
    sessionPath: r.sessionPath,
  }));

  const summary: RunSummary = {
    runId: data.runId,
    status,
    results,
    error: data.error as RunSummary["error"],
    metadata: {
      task: data.task,
      millCommand: data.mill?.command,
      millArgs: data.mill?.args,
      millRunsDir: data.mill?.runsDir,
    },
    observability: {
      status,
      events: [],
      artifacts: [],
      artifactsDir,
      startedAt: data.startedAt ?? Date.now(),
      endedAt: data.completedAt,
    },
  };

  return {
    runId: data.runId,
    status,
    summary,
    startedAt: data.startedAt ?? Date.now(),
    completedAt: data.completedAt,
    acknowledged: true,
    task: data.task,
  };
}

/** Get the sessions base directory. */
export function getSessionsBase(): string {
  return path.join(os.homedir(), ".pi", "agent", "sessions");
}

/**
 * Scan all run.json files under a session's .mill directory.
 * If sessionDirName is provided, scans only that session.
 * If not provided, scans all sessions.
 */
export function scanRuns(
  sessionsBase: string,
  sessionDirName?: string,
): Omit<RunRecord, "promise" | "abort">[] {
  const records: Omit<RunRecord, "promise" | "abort">[] = [];

  const sessionDirs = sessionDirName ? [sessionDirName] : listSessionDirs(sessionsBase);

  for (const dir of sessionDirs) {
    const millDir = path.join(sessionsBase, dir, ".mill");
    if (!fs.existsSync(millDir)) continue;

    try {
      for (const entry of fs.readdirSync(millDir)) {
        const runJsonPath = path.join(millDir, entry, "run.json");
        if (!fs.existsSync(runJsonPath)) continue;
        try {
          const raw = fs.readFileSync(runJsonPath, "utf-8");
          const data: RunJsonData = JSON.parse(raw);
          const reconciled = reconcileRunningStatus(runJsonPath, data);
          records.push(parseRunJson(reconciled, path.join(millDir, entry)));
        } catch {
          // Skip malformed run.json files
        }
      }
    } catch {
      // Skip inaccessible directories
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
 * Cancel a run using metadata from run.json (preferred), with PID-kill fallback.
 * Returns the number of cancellation actions attempted.
 */
export function cancelRunByPidFiles(artifactsDir: string): number {
  let cancelled = 0;

  try {
    const runJsonPath = path.join(artifactsDir, "run.json");
    if (fs.existsSync(runJsonPath)) {
      const data: RunJsonData = JSON.parse(fs.readFileSync(runJsonPath, "utf-8"));
      if (typeof data.runId === "string" && data.runId.length > 0) {
        const command = data.mill?.command?.trim() || "mill";
        const args = [...(data.mill?.args ?? []), "cancel", data.runId];
        if (data.mill?.runsDir && data.mill.runsDir.trim().length > 0) {
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

/** List all session directory names under the sessions base. */
function listSessionDirs(sessionsBase: string): string[] {
  try {
    if (!fs.existsSync(sessionsBase)) return [];
    return fs.readdirSync(sessionsBase).filter((d) => {
      try {
        return fs.statSync(path.join(sessionsBase, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
