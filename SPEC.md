# mill — config-free task actor orchestration runtime (v0 spec)

Status: **Draft for implementation**  
Scope: local CLI + SDK runtime, detached async runs, imported program API, built-in agent providers, Effect v4 / effect-smol internals.

## 1) Product definition

`mill` runs TypeScript orchestration programs that create and coordinate AI agent task actors. A normal program imports the program API from `@mill/core/program`; there is no ambient runtime global in core/CLI authoring and no config-file requirement.

```ts
import { codex, task } from "@mill/core/program";

const review = task({
  agent: codex("openai-codex/gpt-5.3-codex"),
  system: "You inspect code carefully.",
  prompt: "Review src/auth.",
}).start();

await review.done;
```

The CLI persists durable run state, task-native events, task results, and agent session pointers under the default run store (`~/.mill/runs`) unless `--runs-dir` is supplied.

## 2) Public language

- **Run**: one durable execution of a mill program.
- **Task**: one delegated unit of agent work.
- **Task actor**: the handle returned by `task(...)` or `mill.task(...)` from `@mill/core/program`.
- **Agent provider**: pure data selecting a provider/model, created with `codex(model)`, `claude(model)`, or `pi(model)`.
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

`.done` is the current Promise boundary for final task results. Internals are Effect-first.

## 3) Program API

Programs import from `@mill/core/program`:

```ts
import { claude, codex, currentMill, mill, pi, task } from "@mill/core/program";
```

The common path uses `task(...)` directly. `mill.task(...)` is the same current-program handle for code that prefers object style. Calling these helpers outside a hosted mill program fails with a tagged program-context error.

Program completion is module evaluation completion. Top-level `await task.done` is enough; no default export or `run(...)` wrapper is required. If a module exports `result` or `default`, the host may use it as the program result; otherwise a single completed task result or `undefined` is used.

## 4) Task snapshots and steering

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
taskActor.send({ type: "message", mode: "queue", content: "Also inspect tests." });
taskActor.send({ type: "message", mode: "interrupt", content: "Stop and focus on auth tokens." });
taskActor.send({ type: "cancel", reason: "User cancelled." });
```

Current implementation models queue/interrupt/reject states in snapshots. Built-in ACP-backed providers support session-level turns and cancellation internally. Fully durable live steering across all run boundaries remains incremental.

## 5) CLI surface

```bash
mill run <program.ts> [--json] [--sync] [--runs-dir <path>] [--confirm=false]
mill status <runId> [--json] [--runs-dir <path>]
mill wait <runId> --timeout <seconds> [--json] [--runs-dir <path>]
mill watch [--run <runId>] [--channel events|io|all] [--source agent|program] [--task <taskId>] [--json] [--runs-dir <path>]
mill ls [--json] [--status <status>] [--runs-dir <path>]
mill cancel <runId> [--json] [--runs-dir <path>]
```

There is no `init` command, no config file, and no provider-selection flags in the normal CLI. Programs choose providers by importing and using `codex(...)`, `claude(...)`, or `pi(...)`.

`mill run` is async by default and returns a `runId` immediately. `--sync` blocks until completion. `--json` writes machine-readable JSON/JSONL to stdout; diagnostics go to stderr.

## 6) Runtime topology

```text
mill CLI or API caller
  -> core run API
    -> engine (run lifecycle, task actors, task events, persistence)
      -> program host (dynamic import under ProgramContext)
        -> @mill/core/program task(...)
          -> built-in or supplied agent runtime
            -> agent process / session
```

The program host uses a current `ProgramContext` bridge for imported program helpers. It does not inject an ambient runtime global in normal core/CLI execution.

## 7) Run model and storage

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
      tasks/
        <taskId>.json
```

Persisted orchestration records use task vocabulary: `task:*`, `taskId`, and `tasks`.

## 8) Built-in providers

The CLI registers built-in ACP-backed providers for Claude, Codex, and pi. Normal docs do not ask users to import the ACP implementation package. Provider factories are imported from `@mill/core/program`:

```ts
import { claude, codex, pi } from "@mill/core/program";
```

CLI help lists the built-in providers and example authoring shape. Programs pass model strings explicitly; mill does not maintain or discover a model catalog.

## 9) Boundary contracts: public Promise API, internal Effect core

Rule of thumb:

- **User-facing surface**: task actor `.done`, runtime facade methods, and simple interfaces.
- **Everything else**: Effect v4-first (`Effect`, `Stream`, `Layer`) + Schema-defined domain types.

Public boundary files are `*.api.ts` and approved entrypoints. Internal files use `*.effect.ts`, `*.schema.ts`, and `*.codec.ts` naming. Effect/Promise bridging happens only at public boundaries.

Effect v4 / effect-smol baseline:

```json
{
  "dependencies": {
    "effect": "4.0.0-beta.59",
    "@effect/platform-bun": "4.0.0-beta.59"
  }
}
```

## 10) Event model

Tier 1 persisted events are structured facts written to `events.ndjson`:

- `run:start`
- `run:status`
- `run:complete`
- `run:failed`
- `run:cancelled`
- `task:start`
- `task:milestone`
- `task:tool_call`
- `task:error`
- `task:complete`
- `task:cancelled`

Tier 2 IO events are line-oriented stdout/stderr passthrough, available through `mill watch --channel io|all`.

## 11) Program execution

The core program host dynamically imports the program under a `ProgramContext`. Top-level await controls completion. The imported program API creates task actors bound to the current run.

Background worker command is private implementation detail. CLI `run` submits and detaches the worker unless `--sync` is used.

## 12) Cancellation semantics

`mill cancel <runId>` marks a run cancelled and terminates the worker process tree if still running. Task-level cancellation is represented in the actor API and in built-in agent sessions where supported.

## 13) Toolchain and guardrails

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

Guardrails enforce Effect-first internals, tagged/handled errors, IO at explicit platform edges, no public imports of private implementation modules, and visible file-boundary naming.

## 14) Acceptance invariants

1. `mill run <program.ts>` returns a durable `runId` by default.
2. `mill run <program.ts> --sync --json` returns a structured terminal result.
3. Public examples import from `@mill/core/program` and use `task({ agent: codex(...) }).start(); await task.done`.
4. No config-file setup, provider-selection CLI flags, or ambient-runtime-global authoring path exists in core/CLI docs.
5. Public Promise boundary is task actor `.done` and runtime facade methods; internals remain Effect v4-first.
6. Snapshots are current reduced state; events are append-only history.
7. CLI lifecycle commands (`run`, `status`, `wait`, `watch`, `cancel`, `ls`) remain stable.
