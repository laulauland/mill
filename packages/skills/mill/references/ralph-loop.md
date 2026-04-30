---
name: mill-ralph-loop
description: Iterative task execution using the Ralph Loop pattern. Use when an agent should repeatedly work until checks or a task queue is clean.
---

# Ralph Loop Pattern

The Ralph Loop runs a fresh task actor each iteration while the filesystem carries state forward.

## Core characteristics

1. Reuse the same `system` instructions each iteration.
2. Persist progress in files, tests, and commits.
3. Stop on an explicit exit condition or maximum iteration count.
4. Inspect `stopReason`, `errorMessage`, and task text after each task.

## Basic structure

```ts
import { claude, task } from "@mill/core/program";

const maxIterations = 10;
let done = false;

for (let iteration = 1; !done && iteration <= maxIterations; iteration++) {
  const worker = task({
    agent: claude("anthropic/claude-sonnet-4-6"),
    role: "worker",
    system: "You fix issues iteratively. Make minimal changes and verify your work.",
    prompt: "Fix the next issue. Report whether everything is clean.",
  }).start();

  const result = await worker.done;

  if (result.stopReason === "error" || result.errorMessage) {
    break;
  }

  done = result.text.toLowerCase().includes("all clean");
}
```

## Check-output loop

Use a task to inspect failing check output and fix the next failure. If the check command is run outside mill by the orchestrating agent, paste its output into the prompt.

```ts
import { claude, task } from "@mill/core/program";

const failingOutput = `PASTE CHECK OUTPUT HERE`;

const fixer = task({
  agent: claude("anthropic/claude-sonnet-4-6"),
  role: "fixer",
  system:
    "You fix failing checks iteratively. Keep changes focused and rerun the command before reporting done.",
  prompt: `Fix the next set of failures from this check output:\n\n${failingOutput}`,
}).start();

await fixer.done;
```

## Parallel loops

For independent modules, start one actor per module and await their `done` promises:

```ts
import { claude, task } from "@mill/core/program";

const modules = ["auth", "api", "ui"];
const tasks = modules.map((moduleName) =>
  task({
    agent: claude("anthropic/claude-sonnet-4-6"),
    role: `fix-${moduleName}`,
    system: `Fix issues in ${moduleName}. Verify locally before reporting done.`,
    prompt: `Work only in ${moduleName}.`,
  }).start(),
);

const results = await Promise.all(tasks.map((taskActor) => taskActor.done));
```
