# Mill spec

Status: target shape for the rewrite. Read alongside `/CONTEXT.md` (canonical glossary) and `docs/rewrite-plan.md` (implementation phases).

Mill is an Effect-native, supervised task runtime. Operators run TypeScript programs with `mill`; each program is a task that may spawn child agent tasks. Tasks form a tree, are addressable by id, communicate through commands, journal their history as events, and project current state from those events.

## Model

Every unit of work is a **task**. A task has:

- An id (`taskId`).
- A kind: `program` or `agent` (future kinds: `shell`, `http`, `workflow`, `composite`).
- A parent id (absent for root tasks).
- Lifecycle status: `created | started | completed | failed | cancelled`.
- A mailbox for incoming messages.
- A projected snapshot built by the reducer over its event stream.

A program task is the root of a tree. An agent task is a leaf or internal node. There is no separate "run" entity; what previous designs called a run is a program task.

## Public API

Programs author against `@mill/core/program`:

```ts
import { task, codex } from "@mill/core/program";

const review = task({
  agent: codex("openai-codex/gpt-5.3-codex"),
});

const turn = await review.send("Review src/auth.");
review.complete();
await review.done;
```

`task(...)` creates a task; the first `send()` transitions it from `created` to `started`. Returned value type is `Task` — the public handle. Calling `task(...)` outside a hosted program raises a tagged context error.

Effect-native callers use the top-level service:

```ts
import { Mill } from "@mill/core";

await Mill.submit(programPath);
await Mill.status(taskId);
```

`Mill.Default` is the production Layer. Test layers sit alongside (`Mill.Test`).

A Promise facade for non-Effect callers lives at `@mill/core/runtime`:

```ts
import { createMillRuntime } from "@mill/core/runtime";
```

Built on top of the Effect API; intended for embedders.

### Task handle

```ts
interface Task {
  readonly id: TaskId;
  readonly done: Promise<TaskOutput>;
  result(): Promise<TaskResult>;
  snapshot(): Promise<TaskSnapshot>;
  send(message: string): Promise<TurnResult>;
  complete(): void;
  cancel(reason?: string): void;
  run(message: string): Promise<TaskOutput>;
  subscribe(): Stream<TaskEvent>;
}

type TurnResult = { text: string; sequence: number };
type TaskOutput = { kind: "agent"; text: string };

type TaskResult =
  | { status: "completed"; output: TaskOutput }
  | { status: "failed"; error: TaskFailedError }
  | { status: "cancelled"; error: TaskCancelledError };
```

### Snapshot

```ts
interface TaskSnapshot {
  readonly id: TaskId;
  readonly status: "created" | "started" | "completed" | "failed" | "cancelled";
  readonly text: string; // current turn's message_chunk projection
  readonly thought: string; // current turn's thought_chunk projection
  readonly history: ReadonlyArray<{ prompt: string; text: string }>;
  readonly pending?: TaskMessage; // an in-memory buffered prompt, if any
  readonly busy: boolean; // true between turn_started and turn_completed
  readonly output?: TaskOutput;
}
```

### Steering

```ts
await task.send("Also inspect tests.");
task.send("Queue this follow-up and continue immediately.");
task.cancel("Operator cancelled.");
```

`send()` queues prompts in order and returns a promise for that turn's `TurnResult`. `complete()` tells the runtime to finish after the current turn drains and no queued prompts remain. `cancel()` is its own structural command.

## Commands and queries

CQRS split.

**Commands** (mailbox-routed, serial, mutate state):

```
CreateTask({ parentId?, kind, input })  →  task:created
SendMessage({ id, message })             →  task:started on first send; then task:turn_started/chunks/task:turn_completed
CompleteTask({ id })                      →  task:completed after current turn drains and inbox is empty
CancelTask({ id, reason? })              →  task:cancelled
```

Spawning is creating-with-parent; no separate `SpawnChildTask`.

**Queries** (reads, parallel):

```
GetTask({ id })                  →  current snapshot
GetSubtree({ rootId })           →  recursive snapshot
AwaitTask({ id })                →  resolves with output on completed; fails on failed/cancelled
WatchTask({ id, fromSeq? })      →  stream of events
```

## Events

Single past-tense vocabulary. Persisted to `events.ndjson`.

```
task:created
task:started
task:child_spawned        (parent's log only)
task:turn_started
task:turn_completed
task:message_chunk
task:thought_chunk
task:tool_called
task:tool_returned
task:completed
task:failed
task:cancelled
```

Rules:

- Commands are requests. Events are durable facts. State is a projection.
- Streaming chunks are first-class events. The reducer folds them into `snapshot.text` / `snapshot.thought`. The event log is the single source of truth.
- The child's existence appears in the parent's log via `task:child_spawned`. The child's own log starts with `task:created`.

## Supervision

Default policy:

- Parent cancellation cascades to descendants.
- Terminal parent rejects new child spawns.
- Root program task cancellation cancels the entire tree.
- The program task completes when module evaluation completes and any awaited child work has settled.
- Agent child failure does not fail the program unless user code awaits or propagates it.
- `mill status` projects the root subtree.

This default is implicit. Explicit policies (`cascade_cancel`, `isolate_failures`, etc.) may be added later under plain-English names; OTP terms (`one_for_one`, `rest_for_one`) are not adopted.

## Storage

```text
~/.mill/tasks/<taskId>/        (only roots get a directory)
  task.json                    program task record (id, kind, status, paths)
  events.ndjson                full subtree event log, keyed by taskId per event
  result.json                  terminal result (projection summary)
  program.ts                   source of the program
  worker.pid                   worker process pid (program tasks only)
  tasks/<childId>.json         per-child projected snapshots
  logs/
    worker.log
    cancel.log
```

The whole tree's events live in one `events.ndjson` keyed by `taskId` per event. `mill watch <taskId>` is a single-file tail. Recovery is single-log replay.

`--tasks-dir <path>` overrides the root.

## CLI

```bash
mill run <program.ts> [--json] [--quiet] [--sync] [--watch] [--foreground] # creates a program task
mill status <taskId> [--json]                          # task inspection
mill watch <taskId> [--shallow] [--include …] [--json] # stable NDJSON event stream; subtree by default
mill watch <taskId> --raw                              # raw diagnostic NDJSON event stream
mill watch <taskId> [--verbose] [--no-live] [--no-color] # human stateful watch renderer
mill ls [--all] [--status <status>] [--json] [--quiet] # root program tasks; --all for full tree
mill cancel <taskId> [--json]                          # cascades to subtree
```

`mill run` is async by default: it forks a detached worker, prints task metadata (or only `taskId` with `--quiet`), and returns. Human output is optimized for operators and may evolve. `--sync` runs in-process until terminal and prints the final result without streaming. `--watch` preserves the detached worker model but immediately attaches the same event renderer as `mill watch <taskId>`; Ctrl-C detaches the watcher while the worker keeps running. `--foreground` runs the program in the current process, does not write a `worker.pid`, and streams events inline. `--foreground` and `--watch` are mutually exclusive; if `--sync` and `--watch` are both passed, `--watch` wins. `--json` writes stable machine-readable output to stdout; diagnostics go to stderr. Streaming watch JSON is newline-delimited JSON (NDJSON) and remains the boring append-only machine contract. `mill watch` in an interactive terminal reduces the event log into a live task tree; when stdout is not a TTY it emits sparse milestone summaries instead of per-event human spam. `--raw` preserves append-only raw event diagnostics, and `--verbose` shows full ids, tool arguments/results, and correlation ids.

No config file. No provider-selection flags. Programs choose agents in code via `codex(model)`, `claude(model)`, `pi(model)`.

## Agents

Programs reference agents by descriptor:

```ts
{
  agent: codex("openai-codex/gpt-5.3-codex");
}
```

`codex(...)`, `claude(...)`, `pi(...)` return values of public type `Agent`. The internal `AgentRegistry` resolves an `Agent` to an `AgentRuntime`. The CLI registers built-in ACP-backed runtimes for codex/claude/pi. ACP and `spawn-agent` are private implementation details — not exported, not imported by user code.

## Effect architecture

- `Context.Service` / `Layer` for internals.
- `Effect.fn("name")` for named Effect-returning functions.
- `Schema.TaggedErrorClass` / tagged errors at module boundaries.
- `Scope` for program host, console capture, provider sessions.
- `PubSub` / `Stream` for live watch.
- `Queue`, `Ref`, `Deferred`, `Fiber` for local entity hosting.
- Forward-compatible with `effect/unstable/cluster` entity hosting (`TaskEntity` maps to a Cluster `Entity` 1:1).
- No dependency on experimental Machine unless intentionally pinned.

The mechanics are actor-shaped: each task has its own command queue, parents supervise children, cancellation cascades down the tree. Mill is positioned in prose as an _actor-style_ supervised task runtime; the word "actor" does not appear as a type name.

## Package layout

```
packages/core/src/
  index.ts
  program.api.ts                # public program-authoring API
  runtime.api.ts                # Promise facade
  task-reducer.ts               # pure
  ids.ts                        # pure id generator helpers
  schemas/                      # Schema definitions only
    task-command.ts
    task-event.ts
    task-state.ts
    supervision.ts
  services/                     # Effect Layers, PascalCase
    Mill.ts
    TaskEntity.ts
    EntityRegistry.ts
    EventAppender.ts
    TaskStore.ts
    ProgramHost.ts
    AgentRegistry.ts
    PathService.ts
    IdGenerator.ts

packages/cli/src/
  mill.ts
  index.ts
  cli.commands.ts
  cli.handlers.ts
  cli.output.ts
  cli.help.ts
  cli.worker.ts
  cli.platform.ts

packages/provider-acp/src/
  index.ts
  AcpRuntime.ts
  AcpClient.ts
  AcpEvents.ts
  ProcessConfig.ts
```

`*.effect.ts` and `*.schema.ts` suffixes are retired. Folder placement carries the role: `schemas/` for Schema definitions, `services/` for Effect Layers, top level for public APIs and pure modules.

## Invariants

1. Programs import from `@mill/core/program`.
2. No ambient `mill` global in core/CLI authoring.
3. Built-in agents are selected in program code via `codex`/`claude`/`pi`.
4. No config-file requirement for normal execution.
5. `mill run` is async by default and returns a `taskId`.
6. Every task has exactly one terminal status.
7. Events are append-only, past-tense facts; snapshots are reduced projections.
8. The whole subtree of a root task lives in one `events.ndjson`.
9. ACP/`spawn-agent` details remain internal to provider runtime packages.
10. Cluster compatibility: `TaskEntity` shape is a local-mode-now/Cluster-later entity.
