# mill v0 operations and troubleshooting

## Run store

By default, mill writes runs under:

```text
~/.mill/runs/<runId>/
```

Use `--runs-dir <path>` on lifecycle commands to point at a different store.

## Common commands

```bash
mill run program.ts
mill run program.ts --sync --json
mill status <runId> --json
mill wait <runId> --timeout 60 --json
mill watch --run <runId> --channel events
mill watch --run <runId> --channel io --source agent
mill cancel <runId>
mill ls --json
```

There is no config bootstrap command. Programs choose agent providers directly by importing `codex`, `claude`, or `pi` from `@mill/core/program`.

## Program authoring check

A normal program should look like:

```ts
import { codex, task } from "@mill/core/program";

const review = task({
  agent: codex("openai-codex/gpt-5.3-codex"),
  prompt: "Review src/auth.",
}).start();

await review.done;
```

If `task(...)` is called outside a hosted mill program, it fails with a program-context error.

## Cancellation

`mill cancel <runId>` marks the run cancelled and terminates the worker process tree if still running. Task-level cancellation is represented in task actors and in built-in provider sessions where supported.

## Watching output

Use structured events first:

```bash
mill watch --run <runId> --channel events --json
```

Use IO for line-oriented program/agent output:

```bash
mill watch --run <runId> --channel io --source program
mill watch --run <runId> --channel io --source agent
```

## Session pointers

Task results may include a `sessionRef` for the backing agent session. The ACP/session implementation is internal; users should treat the pointer as an opaque reference for inspection or recovery workflows.
