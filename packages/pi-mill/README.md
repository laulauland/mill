# pi-mill

A [pi](https://pi.dev) extension that adds a `subagent` tool, letting your AI coding agent create and monitor delegated mill task runs.

When the orchestrating agent needs to delegate work — run tasks in parallel, assign specialized roles, or break a problem into sub-tasks — it writes a short TypeScript program using `mill.task(...)`. Each task program runs through mill, so driver selection, model routing, run storage, and session management come from your mill config rather than being hardcoded in the extension.

## Install

From npm:

```bash
pi install npm:pi-mill
```

From a local checkout:

```bash
pi install /path/to/mill/packages/pi-mill
```

## Prerequisites

1. A `mill.config.ts` with at least one driver/executor configured (`mill init` to scaffold one).
2. If no bundled CLI is available, `mill` must be on your `PATH` — see [install instructions](https://github.com/laulauland/mill#install).

## How it works

The extension registers a `subagent` tool that accepts two parameters: a `task` label and a `code` string containing TypeScript.

The code runs with a `mill` global (similar to `process` or `console`). The primary method is `mill.task(...)`, which creates a task actor. Start the actor with `.start()` and await `.done` for the final result:

```ts
// Sequential — one task after another
const analysis = mill
  .task({
    agent: "analyzer",
    model: "anthropic/claude-sonnet-4-6",
    system: "You analyze codebases for architectural patterns.",
    prompt: "Analyze the auth module in src/auth/",
  })
  .start();

const analysisResult = await analysis.done;

const fix = mill
  .task({
    agent: "fixer",
    model: "openai-codex/gpt-5.3-codex",
    system: "You fix code issues.",
    prompt: `Fix the issues found: ${analysisResult.text}`,
  })
  .start();

return await fix.done;
```

Parallel work is just multiple task actors:

```ts
const tests = mill
  .task({
    agent: "test-writer",
    model: "anthropic/claude-sonnet-4-6",
    system: "You write tests.",
    prompt: "Write tests for src/auth/",
  })
  .start();

const docs = mill
  .task({
    agent: "documenter",
    model: "cerebras/zai-glm-4.7",
    system: "You write documentation.",
    prompt: "Document the auth module.",
  })
  .start();

const [testResult, docsResult] = await Promise.all([tests.done, docs.done]);
return `${testResult.text}\n\n${docsResult.text}`;
```

Each submitted program becomes an async mill run (`mill run --json`) and pi-mill follows completion via mill runtime APIs (`wait` + `watch --channel events`). Model selection, driver routing, and execution behavior all come from your mill configuration.

Task actor snapshots expose current reduced state for UIs: `idle`, `starting`, `running`, `waiting`, `queued`, `interrupting`, `complete`, `failed`, or `cancelled`, plus accumulated text, queue, result, or error. Events remain the append-only history in mill's run store.

By default, mill run storage uses mill's global default (`~/.mill/runs`) unless you explicitly pass `--runs-dir` (or set `millRunsDir`).

pi-mill monitor views are built from canonical mill runs in `~/.mill/runs` (filtered to runs tagged with `metadata.source = "pi-mill"`).

Runs are **async by default** — the tool returns a `runId` immediately and delivers results via notification when complete.

## Monitoring

- `/mill` — opens an overlay inside pi showing all active and completed runs
- `pi --mill` — standalone full-screen monitor for watching runs from a separate terminal
- A status widget shows run progress inline during conversations

Cancelling runs works via either monitor (mapped to `mill cancel`).

## Configuration

Edit the `config` export in `index.ts`:

```ts
export const config = {
  maxDepth: 1,
  millCommand: "mill",
  millArgs: [],
  millRunsDir: undefined,
  prompt: "...",
};
```

| Option        | Description                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `maxDepth`    | Subagent nesting limit. `1` = agents can create child mill runs, but those children cannot create their own. `0` = disabled. |
| `millCommand` | Executable name or path for mill. If set to `"mill"` (default), pi-mill prefers a bundled CLI when present.                  |
| `millArgs`    | Extra args prepended to every mill invocation.                                                                               |
| `millRunsDir` | Override for `--runs-dir`.                                                                                                   |
| `prompt`      | Additional guidance appended to the tool description (model selection hints, project conventions, etc).                      |

## Context flow

Each subagent receives the parent session path and can use `search_thread` to explore the orchestrator's conversation for context. Results include each subagent's `sessionPath` (session reference, typically provided by the selected ACP agent) for later inspection and context recovery.
