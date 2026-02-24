# @mill/pi-mill

A pi extension that provides the same `subagent` tool + TUI monitor workflow as your existing setup, but executes each child task through **mill** (`mill run --sync --json`) instead of spawning `pi` directly.

## What stays the same

- `subagent` tool contract (`task` + `code`)
- Program-mode orchestration with `factory.spawn(...)`
- Async return (immediate run id, completion notification)
- `/mill` overlay monitor
- `pi --mill` standalone monitor
- Status widget + batched completion notifications
- Bundled skills (`mill-basics`, `mill-ralph-loop`, `mill-worktree`)

## What changed

- Child execution is now delegated to `mill`.
- Each `factory.spawn(...)` compiles to a tiny temporary mill program with one `mill.spawn(...)` call.
- Driver/executor/model behavior comes from your mill defaults and config resolution.

## Install as a pi package

```bash
pi install /absolute/path/to/mill/packages/pi-mill
```

(or add as a local package in your pi settings).

## Mill prerequisites

1. `mill` must be on your `PATH` (or configure a custom command below).
2. Configure your global/project `mill.config.ts` with real drivers/executors as needed.

## Extension config

Edit `index.ts`:

```ts
export const config = {
  maxDepth: 1,
  millCommand: "mill",
  millArgs: [],
  millRunsDir: undefined,
  prompt: "...optional extra guidance for the tool description...",
};
```

- `maxDepth`: subagent nesting limit (`PI_FACTORY_DEPTH` guard)
- `millCommand`: executable name/path for mill
- `millArgs`: extra args prepended to every mill invocation
- `millRunsDir`: optional override for `--runs-dir`
- `prompt`: additional model/tool guidance appended to tool description

## Notes

- Cancelling via `/mill` or `pi --mill` still works (PID-based).
- `ExecutionResult.sessionPath` now contains mill driver `sessionRef` when available.
- This package intentionally keeps the old UX while switching execution backend to mill.
