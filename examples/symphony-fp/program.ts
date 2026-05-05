// Symphony-shaped orchestrator over fp.dev.
//
// Polls `fp issue list --format json` on a tick, claims `todo` issues whose
// dependencies are all `done`, and runs one mill subprogram per issue in an
// isolated workspace. Reconciles on every tick: if an issue moves to `done`
// or `cancelled` externally, the running worker is cancelled.
//
// Two trigger modes (set via FP_SYMPHONY_TRIGGER):
//   "poll"   (default) — poll every POLL_INTERVAL_MS
//   "watch"  — also fs-watch .fp/symphony/trigger; the bundled fp extension
//              touches that file on issue:status:changed for instant pickup
//
// Run from an fp-initialized project root:
//   mill run path/to/symphony-fp/program.ts --foreground
//
// Required: `fp` and `mill` on PATH; FP project initialised (`fp init`).

import { shell } from "@mill/core/program";
import { mkdir, watch } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

type IssueId = string;
type Status = "todo" | "in-progress" | "done";
type Priority = "low" | "medium" | "high" | "critical" | null;

type Issue = {
  id: IssueId;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  parent: string | null;
  dependencies: ReadonlyArray<IssueId>;
};

const POLL_INTERVAL_MS = Number(process.env.SYMPHONY_POLL_MS ?? 30_000);
const MAX_CONCURRENT = Number(process.env.SYMPHONY_MAX_CONCURRENT ?? 3);
const MAX_BACKOFF_MS = 5 * 60_000;
const TRIGGER_MODE = process.env.FP_SYMPHONY_TRIGGER === "watch" ? "watch" : "poll";
const ROOT = process.cwd();
const WORKSPACES_DIR = `${ROOT}/.fp/symphony/workspaces`;
const TRIGGER_FILE = `${ROOT}/.fp/symphony/trigger`;
const WORKER_PATH = `${dirname(fileURLToPath(import.meta.url))}/worker.ts`;
const PRIORITY_RANK: Record<NonNullable<Priority>, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

type Run = { workerHandle: { cancel: (reason?: string) => void }; attempt: number };

const claimed = new Set<IssueId>();
const running = new Map<IssueId, Run>();
const retry = new Map<IssueId, { attempt: number; nextAt: number }>();
let stopped = false;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const fetchAllIssues = async (): Promise<Issue[]> => {
  const out = await shell({
    command: "fp",
    args: ["issue", "list", "--format", "json"],
    cwd: ROOT,
    failOnNonZeroExit: true,
  }).run();
  if (out.kind !== "shell") throw new Error("expected shell output");
  return JSON.parse(out.stdout) as Issue[];
};

const isEligible = (issue: Issue, byId: Map<IssueId, Issue>): boolean => {
  if (issue.status !== "todo") return false;
  if (claimed.has(issue.id)) return false;
  for (const blockerId of issue.dependencies) {
    const blocker = byId.get(blockerId);
    if (blocker === undefined) continue;
    if (blocker.status !== "done") return false;
  }
  const r = retry.get(issue.id);
  if (r !== undefined && Date.now() < r.nextAt) return false;
  return true;
};

const sortByPriority = (a: Issue, b: Issue): number => {
  const ra = a.priority === null ? 99 : PRIORITY_RANK[a.priority];
  const rb = b.priority === null ? 99 : PRIORITY_RANK[b.priority];
  return ra - rb;
};

const ensureWorkspace = async (issue: Issue): Promise<string> => {
  const path = `${WORKSPACES_DIR}/${issue.id}`;
  await mkdir(path, { recursive: true });
  return path;
};

const writeFpComment = async (issueId: IssueId, message: string): Promise<void> => {
  await shell({
    command: "fp",
    args: ["comment", "add", issueId, message],
    cwd: ROOT,
    failOnNonZeroExit: false,
  }).run();
};

const setIssueStatus = async (issueId: IssueId, status: Status): Promise<void> => {
  await shell({
    command: "fp",
    args: ["issue", "update", issueId, "--status", status],
    cwd: ROOT,
    failOnNonZeroExit: false,
  }).run();
};

const runAttempt = async (issue: Issue, attempt: number): Promise<void> => {
  const workspace = await ensureWorkspace(issue);

  await setIssueStatus(issue.id, "in-progress");
  await writeFpComment(issue.id, `[symphony] starting attempt ${attempt} in ${workspace}`);

  // Each issue runs as a separate `mill run worker.ts --sync` so its agent
  // inherits the workspace cwd. Cancellation cascades when we kill the shell.
  const handle = shell({
    command: "mill",
    args: ["run", WORKER_PATH, "--sync", "--quiet"],
    cwd: workspace,
    env: {
      ...process.env,
      SYMPHONY_ISSUE_ID: issue.id,
      SYMPHONY_ISSUE_TITLE: issue.title,
      SYMPHONY_ISSUE_DESCRIPTION: issue.description,
      SYMPHONY_ATTEMPT: String(attempt),
      SYMPHONY_WORKSPACE: workspace,
    },
    failOnNonZeroExit: false,
  });

  running.set(issue.id, { workerHandle: handle, attempt });

  try {
    const result = await handle.run();
    if (result.kind !== "shell") throw new Error("expected shell output");

    if (result.exitCode === 0) {
      retry.delete(issue.id);
      await writeFpComment(issue.id, `[symphony] worker exited cleanly`);
    } else {
      const next = Math.min(10_000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      retry.set(issue.id, { attempt: attempt + 1, nextAt: Date.now() + next });
      await writeFpComment(
        issue.id,
        `[symphony] worker exited ${result.exitCode}; retry in ${Math.round(next / 1000)}s`,
      );
    }
  } catch (err) {
    const next = Math.min(10_000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    retry.set(issue.id, { attempt: attempt + 1, nextAt: Date.now() + next });
    await writeFpComment(
      issue.id,
      `[symphony] worker errored: ${String(err)}; retry in ${Math.round(next / 1000)}s`,
    );
  } finally {
    running.delete(issue.id);
    claimed.delete(issue.id);
  }
};

const reconcile = (current: Issue[]): void => {
  const byId = new Map(current.map((i) => [i.id, i]));
  for (const [id, run] of running) {
    const live = byId.get(id);
    if (live === undefined || live.status === "done") {
      run.workerHandle.cancel("CanceledByReconciliation");
    }
  }
};

const dispatch = (current: Issue[]): void => {
  const byId = new Map(current.map((i) => [i.id, i]));
  const eligible = current.filter((i) => isEligible(i, byId)).sort(sortByPriority);

  for (const issue of eligible) {
    if (running.size >= MAX_CONCURRENT) break;
    claimed.add(issue.id);
    const attempt = retry.get(issue.id)?.attempt ?? 1;
    void runAttempt(issue, attempt);
  }
};

const tick = async (): Promise<void> => {
  try {
    const issues = await fetchAllIssues();
    reconcile(issues);
    dispatch(issues);
  } catch (err) {
    console.error(`[symphony] tick failed: ${String(err)}`);
  }
};

const startTriggerWatch = async (onTrigger: () => void): Promise<() => void> => {
  await mkdir(`${ROOT}/.fp/symphony`, { recursive: true });
  const ac = new AbortController();
  void (async () => {
    try {
      const watcher = watch(TRIGGER_FILE, { signal: ac.signal });
      for await (const _ of watcher) {
        if (stopped) break;
        onTrigger();
      }
    } catch (err) {
      if (!stopped) console.error(`[symphony] watcher errored: ${String(err)}`);
    }
  })();
  return () => ac.abort();
};

export default async function symphony(): Promise<void> {
  process.on("SIGTERM", () => {
    stopped = true;
  });
  process.on("SIGINT", () => {
    stopped = true;
  });

  await mkdir(WORKSPACES_DIR, { recursive: true });

  let stopWatch: (() => void) | undefined;
  if (TRIGGER_MODE === "watch") {
    console.log(`[symphony] watching ${TRIGGER_FILE} for fp extension triggers`);
    stopWatch = await startTriggerWatch(() => {
      console.log(`[symphony] trigger fired; running tick`);
      void tick();
    });
  }

  console.log(
    `[symphony] starting; trigger=${TRIGGER_MODE} poll=${POLL_INTERVAL_MS}ms max=${MAX_CONCURRENT}`,
  );

  while (!stopped) {
    await tick();
    await sleep(POLL_INTERVAL_MS);
  }

  console.log(`[symphony] stopping; cancelling ${running.size} in-flight workers`);
  for (const run of running.values()) run.workerHandle.cancel("Shutdown");
  if (stopWatch !== undefined) stopWatch();
}
