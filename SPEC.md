# mill — Effect-first task actor orchestration runtime (v0 spec)

Status: **Draft for implementation**  
Scope: local CLI + SDK runtime, detached async runs, generic drivers, Effect v4 / effect-smol internals

---

## 1) Product definition

`mill` is a runtime for executing TypeScript orchestration programs that create and coordinate AI agent task actors.

A mill program is regular TypeScript. The injected `mill` global exposes task actors; package helpers provide agent provider factories:

```ts
import { codex } from "@mill/core";

const task = mill.task({
  agent: codex("openai-codex/gpt-5.3-codex"),
  system: "You inspect code.",
  prompt: "Review src/auth.",
}).start();

return await task.done;
```

`mill` stores orchestration state and structured run events. Agent conversations remain owned by each agent tool; mill persists `sessionRef` pointers.

---

## 2) Public language

- **Run**: a durable execution of one mill program.
- **Task**: one delegated unit of agent work.
- **Task actor**: the handle returned by `mill.task(...)`.
- **Agent provider**: pure data selecting a driver/model, created with `codex(model)`, `claude(model)`, or `pi(model)`.
- **Snapshot**: the actor's current reduced state.
- **Event**: an append-only historical fact in the run log.

Task input:

```ts
interface TaskInput {
  readonly agent: AgentProvider;
  readonly prompt: string;
  readonly system?: string;
  readonly role?: string;
  readonly steering?: "queue" | "interrupt" | "reject";
  readonly metadata?: Readonly<Record<string, string>>;
}
```

Task actors:

```ts
interface TaskActor {
  readonly id: string;
  readonly done: Promise<TaskResult>;
  start(): TaskActor;
  stop(): TaskActor;
  cancel(reason?: string): TaskActor;
  send(command: TaskCommand): TaskActor;
  subscribe(listener: (snapshot: TaskSnapshot) => void): { unsubscribe(): void };
  getSnapshot(): TaskSnapshot;
}
```

`.done` is the current Promise boundary for final results. The internals are Effect-first and may expose Effect-native APIs later.

---

## 3) Task snapshots and steering

Events tell you what happened. Snapshots tell you what is true now.

```ts
interface TaskSnapshot {
  readonly id: string;
  readonly status:
    | "idle"
    | "starting"
    | "running"
    | "waiting"
    | "queued"
    | "interrupting"
    | "complete"
    | "failed"
    | "cancelled";
  readonly text: string;
  readonly thought: string;
  readonly queue: ReadonlyArray<QueuedTaskMessage>;
  readonly sessionRef?: string;
  readonly result?: TaskResult;
  readonly error?: string;
}
```

Steering commands:

```ts
task.send({ type: "message", mode: "queue", content: "Also inspect tests." });
task.send({ type: "message", mode: "interrupt", content: "Stop and focus on auth tokens." });
task.send({ type: "cancel", reason: "User cancelled." });
```

Current implementation status:

- Core task actors model queue/interrupt/reject states in snapshots.
- Program-host task actors expose the actor-shaped API and mirror snapshot behavior for authored programs.
- The ACP driver has session-level multi-turn and cancel support through its internal `spawn-agent` integration.
- Fully durable end-to-end steering across program host, run store, and live ACP sessions remains incremental.

---

## 4) CLI surface (v0)

```bash
mill run <program.ts> [--json] [--sync] [--driver <name>] [--executor <name>] [--confirm=false]
mill status <runId> [--json]
mill wait <runId> --timeout <seconds> [--json]
mill watch [--run <runId>] [--channel events|io|all] [--source driver|program] [--spawn <spawnId>] [--json]
mill ls [--json] [--status <status>]
mill cancel <runId> [--json]
mill init [--global]
```

`mill run` is async by default. It returns a `runId` immediately unless `--sync` is passed. The CLI remains the lifecycle surface for durable runs; TypeScript programs use task actors for agent work.

`--json` mode writes machine-readable JSON/JSONL to stdout. Human diagnostics go to stderr.

---

## 5) Runtime topology

```text
mill program (TS)
  -> executor (direct | vm)
    -> engine (run lifecycle, task API injection, events, persistence)
      -> driver (generic)
        -> agent process / remote endpoint

engine events -> watch/tui/automation
```

All layers are orthogonal:

- Executor = where the program runs.
- Driver = how task actors invoke agents.
- Extension = hooks + extra API.
- Observer = event consumer.

---

## 6) Run model and storage

Run state:

```text
pending -> running -> complete
                 -> failed
                 -> cancelled
```

Storage layout:

```text
~/.mill/
  runs/
    <runId>/
      run.json
      events.ndjson
      result.json
      program.ts
      logs/
        worker.log
      spawns/
        <spawnId>.json
```

Some storage/event names still use historical `spawn` vocabulary. Public authoring docs use task actors. The invariant remains: each run and each task-backed driver call has exactly one terminal outcome.

---

## 7) Config and discovery

Minimal config:

```ts
export default {
  defaultDriver: "pi",
  defaultExecutor: "direct",
  authoring: {
    instructions:
      "Create mill.task actors with agent providers. Use system for behavior and prompt for explicit scope + validation.",
  },
};
```

Config resolution order:

1. `./mill.config.ts` from cwd
2. walk upward to repo root
3. `~/.mill/config.ts`
4. built-in defaults

CLI help includes authoring guidance and selected-driver model catalogs. Built-in provider factories are exported by `@mill/core`:

```ts
import { claude, codex, pi } from "@mill/core";
```

---

## 8) Boundary contracts: public Promise API, internal Effect core

Rule of thumb:

- **User-exposed surface**: Promise-based API + interfaces are allowed.
- **Everything else**: Effect v4-first (`Effect`, `Stream`, `Layer`) + Schema-defined domain types.

Public boundary files:

- `*.api.ts`
- approved flat entry files such as `src/index.ts`, `src/types.ts`, and CLI `src/mill.ts`
- ambient program-host declarations

Internal files:

- `*.effect.ts` for Effect programs/services/runtime helpers
- `*.schema.ts` for Schema domain models
- `*.codec.ts` for decode/encode modules

Only `Effect.runPromise` may bridge Effect to Promise, and only at public boundaries. `actor.done` and runtime facade methods are current Promise-facing APIs. Future Effect-native APIs should be additive and keep internals Effect-first.

Effect v4 / effect-smol baseline:

```json
{
  "dependencies": {
    "effect": "4.0.0-beta.59",
    "@effect/platform-bun": "4.0.0-beta.59"
  }
}
```

Exact beta patch versions may move together, but API usage must stay on the Effect v4 line.

---

## 9) Event model

Tier 1 persisted events are structured facts written to `events.ndjson`. Current persisted event names include:

- `run:start`
- `run:status`
- `run:complete`
- `run:failed`
- `run:cancelled`
- `spawn:start`
- `spawn:milestone`
- `spawn:tool_call`
- `spawn:error`
- `spawn:complete`
- `spawn:cancelled`

The `spawn:*` names are a storage/detail vocabulary for the current driver pipeline. Public API docs use task terminology.

Tier 2 IO events are line-oriented stdout/stderr passthrough, available live through `mill watch --channel io|all` and not part of the structured domain log.

---

## 10) Driver architecture

Core does not encode vendor semantics. Drivers translate task execution into protocol/session work.

`@mill/driver-acp` is the built-in driver package for Claude, Codex, and pi. It uses `spawn-agent` internally for ACP process/session handling, model config options, multi-turn session support, and cancellation. `spawn-agent` is not a public mill API.

Driver registrations still expose static model catalogs for CLI help. Live model/config discovery may be added as an explicit command later; normal help must not create ACP sessions.

---

## 11) Executor architecture

### 11.1 Direct executor

- Executes the TS program using Bun in the local environment.
- Injects `globalThis.mill` with actor-shaped task API.
- Enforces scoped lifecycle and cancellation at the run boundary.

### 11.2 VM executor

- Same engine contracts.
- Runs program in a sandboxed runtime when available.

Executor has no driver knowledge.

---

## 12) Program API injected into runtime

```ts
declare global {
  const mill: {
    task(input: TaskInput): TaskActor;
    [key: string]: unknown;
  };
}
```

Behavior:

1. `mill.task(input)` creates a task actor in `idle` state.
2. `.start()` starts the task.
3. `.subscribe(...)` receives snapshot updates.
4. `.send(...)` records queue/interrupt/reject/cancel intent in the actor layer.
5. `.done` resolves or rejects at terminal state.

Legacy lower-level spawn types may remain inside driver/runtime internals while the public program API is task-first.

---

## 13) Background worker process

Internal worker command (private API):

```bash
mill _worker --run-id <id> --program <abs-path> --config <resolved-config> [--driver ...] [--executor ...]
```

Worker responsibilities:

1. mark run `running`
2. execute program through engine
3. append tier-1 events
4. write final `result.json`
5. mark terminal status exactly once

CLI `run` submits and detaches the worker unless `--sync` is used.

---

## 14) Extensions

Extension hooks remain Effect-native. Extension APIs injected into the program host are user-facing and may expose Promise ergonomics, but bridges must use `Effect.runPromise` at public boundaries.

---

## 15) Observers

Observers consume tier-1 stream and optionally tier-2 live IO:

- `mill watch --channel events`
- `mill watch --channel io|all`
- future TUI/web UI
- automation reading NDJSON

Observers are read-only.

---

## 16) Cancellation semantics

`mill cancel <runId>` marks a run cancelled and terminates the worker process tree if still running. Task-level cancellation is represented in the actor API and ACP driver session layer, but full durable propagation of live steering/cancel commands is still being completed incrementally.

---

## 17) Toolchain and guardrails

Required scripts include:

```json
{
  "scripts": {
    "test": "bun test",
    "typecheck": "tsgo --noEmit",
    "lint": "oxlint .",
    "lint:ast-grep": "bun run lint:effect && bun run lint:boundary && bun run lint:runtime-safety",
    "lint:exports": "bun run scripts/check-exports.ts",
    "format": "oxfmt . --write",
    "format:check": "oxfmt . --check",
    "check": "bun run lint:ast-grep:test && bun run lint:exports && bun run lint:ast-grep && bun run lint && bun run format:check && bun run typecheck && bun test"
  }
}
```

Guardrails enforce:

- no raw Promise construction in internal Effect modules
- no direct Bun globals in core runtime
- no shell-string command execution
- no ad-hoc JSON parsing outside schema/codec modules
- no public imports of private implementation modules
- visible file-boundary naming for API/effect/schema/codec code

---

## 18) Acceptance invariants

1. `mill run <program.ts>` returns a durable `runId` by default.
2. `mill run <program.ts> --sync --json` returns a structured terminal result.
3. Public examples use `mill.task({ agent: codex(...) })`.
4. Public Promise boundary is `actor.done` and runtime facade methods; internals remain Effect v4-first.
5. Snapshots are current reduced state; events are append-only history.
6. CLI lifecycle commands (`run`, `status`, `wait`, `watch`, `cancel`, `ls`) remain stable.
7. `spawn-agent` remains internal to `@mill/driver-acp`.
