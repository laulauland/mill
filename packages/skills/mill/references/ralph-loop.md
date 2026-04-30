---
name: mill-ralph-loop
description: Iterative task execution using the Ralph Loop pattern. Use when an agent should repeatedly work until lint, tests, or a task queue is clean.
---

# Ralph Loop Pattern

The Ralph Loop runs a fresh task actor each iteration while the filesystem carries state forward.

## Core Characteristics

1. Reuse the same `system` instructions each iteration.
2. Persist progress in files, tests, and commits.
3. Stop on an explicit exit condition or maximum iteration count.
4. Inspect `exitCode`, `stopReason`, and `errorMessage` after each task.

## Basic Structure

```ts
const maxIterations = 10;
let done = false;

for (let iteration = 1; !done && iteration <= maxIterations; iteration++) {
  mill.observe.log("info", `Iteration ${iteration}`, { maxIterations });

  const task = mill
    .task({
      agent: "worker",
      system: "You fix issues iteratively. Make minimal changes and verify your work.",
      prompt: "Fix the next issue. Report whether everything is clean.",
      model: "anthropic/claude-sonnet-4-6",
      step: iteration,
    })
    .start();

  const result = await task.done;

  if (result.exitCode !== 0 || result.stopReason === "error") {
    mill.observe.log("error", "Agent failed", {
      iteration,
      error: result.errorMessage,
    });
    break;
  }

  done = result.text.toLowerCase().includes("all clean");
}
```

## Lint/Test Loop

Run a local verifier before each actor invocation and only call the agent when there is work to fix.

```ts
import { spawnSync } from "node:child_process";

for (let iteration = 1; iteration <= 20; iteration++) {
  const check = spawnSync("bun", ["run", "check"], {
    cwd: process.cwd(),
    encoding: "utf-8",
  });

  if (check.status === 0) {
    mill.observe.log("info", "Checks are clean", { iteration });
    break;
  }

  const task = mill
    .task({
      agent: "fixer",
      system: "You fix failing checks iteratively. Keep changes focused and rerun the command.",
      prompt: `bun run check failed. Fix the next set of failures.\n\nSTDOUT:\n${check.stdout}\n\nSTDERR:\n${check.stderr}`,
      model: "anthropic/claude-sonnet-4-6",
      step: iteration,
    })
    .start();

  const result = await task.done;
  if (result.exitCode !== 0) break;
}
```

## Parallel Loops

For independent modules, start one actor per module and await their `done` promises:

```ts
const tasks = modules.map((moduleName, step) =>
  mill
    .task({
      agent: `fix-${moduleName}`,
      system: `Fix issues in ${moduleName}. Verify locally before reporting done.`,
      prompt: `Work only in ${moduleName}.`,
      model: "anthropic/claude-sonnet-4-6",
      step,
    })
    .start(),
);

const results = await Promise.all(tasks.map((task) => task.done));
```
