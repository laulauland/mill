# pi-mill

A [pi](https://pi.dev) extension that adds a `subagent` tool for creating and monitoring delegated mill task runs.

Pi-mill is an extension-specific wrapper around mill. Core/CLI mill programs import from `@mill/core/program`, but pi-mill tool programs are serialized snippets that run with the extension's `mill` global. The extension converts its serialized task shape into core-compatible task input before invoking the mill CLI/runtime.

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

If no bundled CLI is available, `mill` must be on your `PATH` — see the repository install instructions. No core mill config file is required for normal built-in providers.

## How it works

The extension registers a `subagent` tool with two parameters:

- `task`: label for the delegated run.
- `code`: TypeScript script using the pi-mill `mill` global.

The pi-mill task input is intentionally serialized for tool calls:

```ts
const analysis = mill
  .task({
    agent: "analyzer",
    model: "anthropic/claude-sonnet-4-6",
    system: "You analyze codebases for architectural patterns.",
    prompt: "Analyze the auth module in src/auth/.",
  })
  .start();

const analysisResult = await analysis.done;

const fix = mill
  .task({
    agent: "fixer",
    model: "openai-codex/gpt-5.3-codex",
    system: "You fix code issues.",
    prompt: `Fix the issues found:\n\n${analysisResult.text}`,
  })
  .start();

return await fix.done;
```

Here `agent` is a human-readable role label and `model` selects the provider/model. Pi-mill maps that serialized shape to core's provider descriptor internally before execution.

Parallel work is just multiple task actors:

```ts
const tests = mill
  .task({
    agent: "test-writer",
    model: "anthropic/claude-sonnet-4-6",
    system: "You write tests.",
    prompt: "Write tests for src/auth/.",
  })
  .start();

const docs = mill
  .task({
    agent: "documenter",
    model: "openai-codex/gpt-5.3-codex",
    system: "You write documentation.",
    prompt: "Document the auth module.",
  })
  .start();

const [testResult, docsResult] = await Promise.all([tests.done, docs.done]);
return `${testResult.text}\n\n${docsResult.text}`;
```

Each submitted snippet becomes an async mill run. Pi-mill follows completion via mill runtime APIs and run events. The default run store is `~/.mill/runs` unless `millRunsDir` is set.

Task actor snapshots expose current reduced state for UIs: `idle`, `starting`, `running`, `waiting`, `queued`, `interrupting`, `complete`, `failed`, or `cancelled`, plus accumulated text, queue, result, or error.

Runs are async by default: the tool returns a `runId` immediately and delivers results via notification when complete.

## Monitoring

- `/mill` — opens an overlay inside pi showing active and completed runs.
- `pi --mill` — standalone full-screen monitor for watching runs from a separate terminal.
- A status widget shows run progress inline during conversations.

Cancelling runs works via either monitor and maps to `mill cancel`.

## Extension configuration

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
| `prompt`      | Additional guidance appended to the tool description, such as model selection hints or project conventions.                  |

This is pi extension configuration, not core mill runtime configuration.

## Context flow

Each subagent receives the parent session path and can use `search_thread` to explore the orchestrator's conversation for context. Results include each subagent's `sessionPath` for later inspection and context recovery.

## Cleanup status

Pi-mill's public tool contract is aligned with task actors and `system`, but its extension runtime remains a Pi-specific adapter layer. Core/CLI docs should not be copied directly into pi-mill snippets without accounting for the serialized `agent` label + `model` shape described above.
