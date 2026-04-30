---
name: mill
description: "Write mill orchestration programs for parallel/sequential agent workflows, iterative Ralph Loop execution, and worktree-isolated development."
---

# mill

Use this skill when writing or reviewing a mill orchestration program for the core CLI/runtime.

## Core rules

1. Import program helpers from `@mill/core/program`.
2. Create task actors with `task({ agent: codex(...), system, prompt }).start()`.
3. Use top-level `await task.done`; no global `mill`, config file, or default export is required.
4. Keep `system` (WHO/how) separate from `prompt` (WHAT/task).
5. Use `await` for sequential work and `Promise.all` for independent parallel work.
6. Select an explicit provider/model with `codex(model)`, `claude(model)`, or `pi(model)`.
7. Inspect `result.text`, `result.stopReason`, and `result.errorMessage` before trusting outputs.

## Minimal program

```ts
import { codex, task } from "@mill/core/program";

const review = task({
  agent: codex("openai-codex/gpt-5.3-codex"),
  system: "You inspect code carefully.",
  prompt: "Review src/auth.",
}).start();

await review.done;
```

## Available patterns

- General orchestration patterns: `./references/patterns.md`
- Iterative Ralph Loop pattern: `./references/ralph-loop.md`
- Worktree-isolated parallel development: `./references/worktree.md`

Note: pi-mill tool snippets are extension-specific and still use pi-mill's serialized `mill.task({ agent: roleLabel, model, system, prompt })` shape. Do not confuse that with normal core/CLI programs.
