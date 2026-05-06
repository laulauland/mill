# mill

A supervised task runtime for orchestrating agent and shell work from TypeScript.

> **Status:** Mill is being rewritten ground-up. This README describes the target shape from `docs/spec.md`. Some surfaces are still in flight — see `docs/rewrite-plan.md` for the roadmap.

## Why mill

You can already farm work out to subagents with bash and `claude -p`. Mill is for when you want the orchestration plan to be a readable artifact you confirm before it runs, with structured events you can replay, and the same program portable across providers (Claude, Codex, pi, …).

You talk to your main agent in Pi, Claude Code, OpenCode, etc. When work needs delegation, it writes a short TypeScript program. You review the program, then run it with `mill run`.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/laulauland/mill/main/scripts/install.sh | bash
```

Installs the latest release binary into `$HOME/.local/bin/mill`. Override with `MILL_INSTALL_DIR=/usr/local/bin` or pin a version with `MILL_VERSION=v0.1.9`.

Supported: macOS arm64 (Apple Silicon) and Linux x86_64. For other platforms, build from source.

### From source

Requires [Bun](https://bun.sh):

```bash
git clone https://github.com/laulauland/mill.git && cd mill
bun install
VERSION=$(node -p 'require("./packages/cli/package.json").version')
bun build --compile packages/cli/src/mill.ts \
  --outfile mill --define "__MILL_VERSION__=\"$VERSION\""
mv mill ~/.local/bin/  # or anywhere on your PATH
```

## Quick start

A program spawns tasks. Tasks are agent-backed or shell-backed; both use the same `Task` handle.

```ts
import { codex, claude, shell, task } from "@mill/core/program";

const branch = (
  await shell({ command: "jj", args: ["log", "-r", "@", "--no-graph", "-T", "description"] }).run()
).stdout.trim();

const analysis = task({ agent: codex("openai-codex/gpt-5.3-codex") });
await analysis.send(`Analyze the auth module on branch:\n${branch}`);
analysis.complete();
const findings = await analysis.done; // { kind: "agent", text: string }

const plan = task({ agent: claude("anthropic/claude-opus-4-6") });
await plan.send(`Turn these findings into a plan:\n\n${findings.text}`);
plan.complete();
await plan.done;
```

Run it:

```bash
mill run review.ts                 # forks a worker, prints taskId
mill run review.ts --watch         # same, but live-tail events in this terminal
mill run review.ts --foreground    # run in this process, no fork
mill run review.ts --sync          # block until terminal, no streaming
```

## The `Task` handle

`task({ agent })` and `shell({ command })` return the same handle. The first `send()` (or `run()`) implicitly starts the task — there is no `start()`.

```ts
interface Task {
  readonly id: TaskId;
  readonly done: Promise<TaskOutput>; // resolves on completed; rejects on failed/cancelled
  send(message: string): Promise<TurnResult>;
  complete(): void; // finish after current turn drains
  cancel(reason?: string): void;
  run(message?: string): Promise<TaskOutput>; // send + complete + done
  result(): Promise<TaskResult>; // tagged terminal result
  snapshot(): Promise<TaskSnapshot>;
  subscribe(): Stream<TaskEvent>;
}

type TaskOutput =
  | { kind: "agent"; text: string }
  | { kind: "shell"; stdout: string; stderr: string; exitCode: number };
```

Lifecycle status is one of `created | started | completed | failed | cancelled`.

Steering — call `send()` again while a turn is in flight to queue a follow-up; call `cancel()` to interrupt:

```ts
review.send("Also inspect the tests directory."); // queued
review.cancel("operator changed direction");
```

## Agents

Programs choose agents in code. No config file, no provider flags on the CLI.

```ts
import { claude, codex, pi } from "@mill/core/program";

codex("openai-codex/gpt-5.3-codex");
claude("anthropic/claude-opus-4-6");
pi("your-pi-model-id");
```

These return `Agent` descriptors. The CLI registers built-in ACP-backed runtimes for codex/claude/pi.

## CLI

```
mill run <program.ts> [--sync | --foreground | --watch] [--json] [--quiet]
mill status <taskId>                                   show current task snapshot
mill watch <taskId> [--shallow] [--include …] [--exclude …]
                    [--raw | --verbose | --no-live | --no-color]
                                                       live event view (subtree by default)
mill cancel <taskId>                                   cascade cancel to subtree
mill ls [--all] [--status <status>] [--json] [--quiet] root program tasks; --all for full tree
```

`mill run` is async by default: forks a detached worker and returns a `taskId`. `--sync` runs in-process to terminal. `--foreground` runs in-process with live event output. `--watch` forks the worker and immediately attaches the same renderer as `mill watch`; Ctrl-C detaches without killing the worker.

`mill watch` reduces events into a live task tree on TTYs. Switch to append-only output with `--no-live`, or get raw NDJSON with `--raw` (or `--json`). `--include`/`--exclude` filter event types; `--shallow` scopes to the target task only.

`--json` everywhere produces stable machine output on stdout (diagnostics on stderr).

## Storage

```text
~/.mill/tasks/<taskId>/        # only root program tasks get a directory
  task.json                    # program task record
  events.ndjson                # full subtree event log, keyed by taskId per event
  result.json                  # terminal result projection
  program.ts                   # source of the program
  worker.pid                   # detached worker pid
  tasks/<childId>.json         # per-child snapshot projections
  logs/{worker,cancel}.log
```

The whole subtree of a root task lives in one `events.ndjson`, so `mill watch` is a single-file tail and recovery is single-log replay. Override the root with `--tasks-dir <path>`.

## Use with Claude Code

Install mill, then add the skill:

```bash
npx skills add laulauland/mill
```

This teaches Claude Code how to write and run mill programs. When you ask it to farm work out, it authors a `.ts` program using `task()` / `shell()`, shows it for confirmation, and runs it via the CLI.

## FAQ

**Couldn't I do this with bash and `claude -p`?**
Yes — that's the point. The orchestrator can express a plan in any language. TypeScript is optional; it's just easy to read, and lets mill hook into the task lifecycle for structured events, snapshots, and replay.

**How is this different from Claude Code tasks?**
Claude Code tasks are scoped to Claude Code. Mill programs are portable across providers — the same program runs Claude, Codex, or pi tasks. The program is also a readable artifact you confirm before execution, not an internal dispatch.

**Do I have to write the programs myself?**
No. The orchestrator writes them. You review and confirm.

## Internals

Built on Effect v4. Public boundaries expose Promise ergonomics through the `Task` handle and the `Mill` service facade; the engine, persistence, and entity hosting are Effect-first. `TaskEntity` is shape-compatible with `effect/unstable/cluster` for future cluster hosting.

Authoritative references:

- [`/CONTEXT.md`](./CONTEXT.md) — canonical glossary and decision log.
- [`docs/spec.md`](./docs/spec.md) — target shape (model, API, events, storage, CLI, invariants).
- [`docs/adr/`](./docs/adr/) — load-bearing decisions.
- [`docs/rewrite-plan.md`](./docs/rewrite-plan.md) — implementation roadmap.

| Package              | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `@mill/core`         | Engine, lifecycle, public `Task` and `Mill` API      |
| `@mill/cli`          | CLI commands, built-in agent registrations, watch UI |
| `@mill/provider-acp` | _Internal_ ACP adapter (not a public mill API)       |

## Development

```bash
bun install
bun test
bun run check         # ast-grep + lint + format + typecheck + test
```
