# pi-mill

A [pi](https://pi.dev) extension that adds a `subagent` tool, letting your AI coding agent spawn and orchestrate child agents through [mill](https://github.com/laulauland/mill).

When the orchestrating agent needs to delegate work — run tasks in parallel, assign specialized roles, or break a problem into sub-tasks — it writes a short TypeScript program using `mill.spawn()`. Each spawn becomes a mill run, which means driver selection, model routing, and session management all come from your mill config rather than being hardcoded.

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

1. `mill` must be on your `PATH` (or set a custom command in config).
2. A `mill.config.ts` with at least one driver/executor configured.

## How it works

The extension registers a `subagent` tool that accepts two parameters: a `task` label and a `code` string containing TypeScript.

The code runs with a `mill` global (similar to `process` or `console`). The core method is `mill.spawn()`:

```ts
// Sequential — one agent after another
const analysis = await mill.spawn({
  agent: "analyzer",
  systemPrompt: "You analyze codebases for architectural patterns.",
  prompt: "Analyze the auth module in src/auth/",
  model: "anthropic/claude-sonnet-4-6",
});

const fix = await mill.spawn({
  agent: "fixer",
  systemPrompt: "You fix code issues.",
  prompt: `Fix the issues found: ${analysis.text}`,
  model: "openai-codex/gpt-5.3-codex",
});

// Parallel — multiple agents at once
const [tests, docs] = await Promise.all([
  mill.spawn({
    agent: "test-writer",
    systemPrompt: "You write tests.",
    prompt: "Write tests for src/auth/",
    model: "anthropic/claude-sonnet-4-6",
  }),
  mill.spawn({
    agent: "documenter",
    systemPrompt: "You write documentation.",
    prompt: "Document the auth module.",
    model: "cerebras/zai-glm-4.7",
  }),
]);
```

Each `mill.spawn()` submits an async mill run (`mill run --json`) and then follows completion via mill APIs (`watch` + `inspect`). Model selection, driver routing, and execution behavior all come from your mill configuration.

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

| Option | Description |
|---|---|
| `maxDepth` | Subagent nesting limit. `1` = agents can spawn subagents, but those subagents cannot spawn their own. `0` = disabled. |
| `millCommand` | Executable name or path for mill. |
| `millArgs` | Extra args prepended to every mill invocation. |
| `millRunsDir` | Override for `--runs-dir`. |
| `prompt` | Additional guidance appended to the tool description (model selection hints, project conventions, etc). |

## Context flow

Each subagent receives the parent session path and can use `search_thread` to explore the orchestrator's conversation for context. Results (including each subagent's `sessionPath`) flow back to the orchestrator via `result.text`.
