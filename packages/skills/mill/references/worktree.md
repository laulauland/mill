---
name: mill-worktree
description: Worktree-based parallel development with pi-mill. Use when multiple agents need isolated working directories.
---

# Worktree-Based Parallel Development

Give each editing agent its own jj workspace or git worktree so concurrent changes do not collide. The orchestration program creates worktrees, starts task actors in those directories, collects results, then merges successful work.

## Jujutsu Workspace Pattern

```ts
import { spawnSync } from "node:child_process";

const baseCwd = process.cwd();
const workstreams = [
  {
    name: "auth",
    prompt: "Implement auth module changes.",
    system: "You are a backend engineer. Make focused changes and verify them.",
  },
  {
    name: "api",
    prompt: "Implement API endpoint changes.",
    system: "You are an API engineer. Make focused changes and verify them.",
  },
];

const worktrees: string[] = [];

try {
  for (const stream of workstreams) {
    const wt = `/tmp/pi-worktree-${stream.name}-${Date.now()}`;
    const created = spawnSync("jj", ["workspace", "add", wt], {
      cwd: baseCwd,
      encoding: "utf-8",
    });
    if (created.status !== 0) throw new Error(created.stderr);
    worktrees.push(wt);
  }

  const installTasks = worktrees.map((cwd, step) =>
    mill
      .task({
        agent: `install-${step}`,
        system: "Install project dependencies and verify the install succeeds.",
        prompt: "Install dependencies in this workspace.",
        model: "cerebras/zai-glm-4.7",
        cwd,
        step,
      })
      .start(),
  );
  await Promise.all(installTasks.map((task) => task.done));

  const implementationTasks = workstreams.map((stream, step) =>
    mill
      .task({
        agent: stream.name,
        system: stream.system,
        prompt: stream.prompt,
        model: "anthropic/claude-opus-4-6",
        cwd: worktrees[step],
        step,
      })
      .start(),
  );
  const results = await Promise.all(implementationTasks.map((task) => task.done));

  const failed = results.filter((result) => result.exitCode !== 0);
  const mergeTask = mill
    .task({
      agent: "merger",
      system: "You merge parallel workstream results using jj. Resolve conflicts carefully.",
      prompt: `Merge successful worktrees into ${baseCwd}. Worktrees: ${worktrees.join(", ")}. Failed: ${failed.map((r) => r.agent).join(", ") || "none"}.`,
      model: "anthropic/claude-sonnet-4-6",
      cwd: baseCwd,
      step: workstreams.length,
    })
    .start();
  const mergeResult = await mergeTask.done;

  mill.observe.artifact(
    "worktree-report.md",
    [...results, mergeResult].map((r) => `## ${r.agent}\n${r.text}`).join("\n\n---\n\n"),
  );
} finally {
  for (const wt of worktrees) {
    const name = wt.split("/").pop() ?? "";
    spawnSync("jj", ["workspace", "forget", name], { cwd: baseCwd, encoding: "utf-8" });
    spawnSync("rm", ["-rf", wt], { encoding: "utf-8" });
  }
}
```

Use the same actor shape for git worktrees: create isolated directories, pass each directory as `cwd`, start all independent tasks, and await `task.done` for each one.
