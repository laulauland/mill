---
name: mill-worktree
description: Worktree-based parallel development. Use when multiple agents need isolated working directories.
---

# Worktree-based parallel development

Give each editing agent its own jj workspace or worktree so concurrent changes do not collide. Create workspaces outside the mill program or in a preparatory step, then pass explicit paths in prompts and assign one task per workspace.

## Pattern

```ts
import { claude, codex, task } from "@mill/core/program";

const workstreams = [
  {
    name: "auth",
    path: "/tmp/mill-auth-workspace",
    prompt: "Implement auth module changes in /tmp/mill-auth-workspace.",
    system: "You are a backend engineer. Make focused changes and verify them.",
  },
  {
    name: "api",
    path: "/tmp/mill-api-workspace",
    prompt: "Implement API endpoint changes in /tmp/mill-api-workspace.",
    system: "You are an API engineer. Make focused changes and verify them.",
  },
];

const implementationTasks = workstreams.map((stream) =>
  task({
    agent: codex("openai-codex/gpt-5.3-codex"),
    role: stream.name,
    system: stream.system,
    prompt: `${stream.prompt}\n\nOnly edit files under ${stream.path}.`,
  }).start(),
);

const results = await Promise.all(implementationTasks.map((taskActor) => taskActor.done));

const mergeTask = task({
  agent: claude("anthropic/claude-sonnet-4-6"),
  role: "merger",
  system: "You merge parallel workstream results using jj. Resolve conflicts carefully.",
  prompt: `Merge successful workstreams. Workspaces: ${workstreams.map((w) => w.path).join(", ")}. Results:\n\n${results
    .map((result) => result.text)
    .join("\n\n---\n\n")}`,
}).start();

await mergeTask.done;
```

## Operational notes

- Create and clean up jj workspaces outside the mill program unless your task agent is explicitly responsible for that filesystem work.
- Keep each task's prompt scoped to one workspace path.
- Merge with a dedicated task after independent work completes.
