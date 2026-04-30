# mill v0 product spec

## Product definition

`mill` runs TypeScript orchestration programs that create AI agent task actors. Programs import the hosted program API from `@mill/core/program`; normal core/CLI authoring does not use a global `mill` and does not require a config file.

```ts
import { codex, task } from "@mill/core/program";

const review = task({
  agent: codex("openai-codex/gpt-5.3-codex"),
  system: "You inspect code carefully.",
  prompt: "Review src/auth.",
}).start();

await review.done;
```

The CLI persists durable run state, task events, task results, and session pointers under `~/.mill/runs` by default.

## Public concepts

A **run** is one durable program execution. A **task** is one delegated unit of agent work. A **task actor** is the handle returned by `task(...)` / `mill.task(...)` from `@mill/core/program`. An **agent provider** is pure data produced by `codex(model)`, `claude(model)`, or `pi(model)`. A **snapshot** is current reduced actor state; an **event** is append-only history.

Task actors expose `start()`, `send(...)`, `cancel(...)`, `subscribe(...)`, `getSnapshot()`, and `done`.

## CLI surface

```bash
mill run <program.ts> [--json] [--sync] [--runs-dir <path>] [--confirm=false]
mill status <runId> [--json] [--runs-dir <path>]
mill wait <runId> --timeout <seconds> [--json] [--runs-dir <path>]
mill watch [--run <runId>] [--channel events|io|all] [--source agent|program] [--task <taskId>] [--json] [--runs-dir <path>]
mill ls [--json] [--status <status>] [--runs-dir <path>]
mill cancel <runId> [--json] [--runs-dir <path>]
```

`mill run` is async by default and returns a `runId`. `--sync` blocks until the run reaches a terminal state. `--json` writes machine-readable output to stdout and diagnostics to stderr.

There is no `init` command, config file, or provider-selection flag in v0. Programs choose providers directly through imported provider factories.

## Run execution

```text
CLI/API caller
  -> core run API
    -> engine
      -> program host dynamic import under ProgramContext
        -> @mill/core/program task(...)
          -> built-in or supplied agent runtime
```

Program completion is module evaluation completion. Top-level `await task.done` is sufficient; no default export is required.

## Storage

```text
~/.mill/runs/<runId>/
  run.json
  events.ndjson
  result.json
  program.ts
  logs/worker.log
  tasks/<taskId>.json
```

Persisted orchestration records use `task:*`, `taskId`, and `tasks` vocabulary.

## Built-in providers

The CLI registers built-in ACP-backed providers for `codex`, `claude`, and `pi`. Users import provider factories from `@mill/core/program`. The ACP implementation and `spawn-agent` dependency are internal implementation details.

## Non-goals for v0

- Config-file based provider selection.
- Provider-selection CLI flags.
- Public imports from the ACP implementation package.
- Live model discovery during normal help rendering.
