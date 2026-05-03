# Mill domain language

Canonical terms for code, docs, schemas, CLI, and on-disk surfaces. Internal code may use additional structural names (e.g. `rootTaskId` for the root of a task tree), but every public surface uses the terms below.

## Glossary

### Task
Every unit of work in Mill is a task. There is no separate "run" entity. Tasks form a tree: a top-level task may spawn child tasks; child tasks may spawn their own. Each task has one terminal outcome.

### Task kind
A discriminator on a task: `program` or `agent`.
- **Program task** — a task whose body is a TypeScript program file. Always the root of a tree. Created by `mill run <program.ts>` or by submitting a program through the API.
- **Agent task** — a task whose body is one delegated unit of agent work. Created from inside a program by calling `task({ agent })`; prompts are delivered with `send()`.

Future kinds (`shell`, `http`, `workflow`, `composite`) follow the same model.

### taskId
The single canonical identifier for any task — root or child. There is no `runId`. Surfaces that previously named a top-level identifier use `taskId` of the program task.

### Run (verb only)
"Run" survives only as the CLI verb `mill run <program.ts>` ("execute this program"). It is not a noun, not a type, not a stored field. The thing `mill run` produces is a program task with a `taskId`.

### Task (the public type)

The TypeScript type returned by `task({ agent })`. Has `id`, rejecting `done`, match-style `result()`, live `snapshot()`, `send()`, `complete()`, `cancel()`, `run()`, and `subscribe()`. From a program author's perspective, the variable _is_ the task. All prompts go through `send()`, which returns a per-turn `TurnResult`; the first `send()` implicitly starts the task. Used directly:

```ts
const review: Task = task({ agent: codex(...) });
const turn = await review.send("Review src/auth.");
review.complete();
await review.done;
```

### TaskEntity (internal only)
The runtime that owns a task's command queue, projected state, and event stream. Implementation detail. Lives in `services/`. Never appears in public API or in user-facing docs. Chosen for forward compatibility with `effect/unstable/cluster` `Entity`, which has the same shape (id-addressed, sequential command handlers, events as facts, state as projection).

### Actor model (positioning, not a type)
Mill is positioned in conceptual docs as an actor-style supervised task runtime. The mechanics are actor-shaped: each task has its own command queue, state is private, parents supervise children, cancellation cascades down the tree. The word "actor" does not appear as a type name (no `TaskActor`); it appears in prose where it helps readers ground the mental model.

### Mill (the service)
The top-level Effect service in `@mill/core` — the central abstraction of the package. Composes the entity registry, event appender, store, path service, and id generator into one facade exposing `submit`, `status`, `wait`, `watch`, `cancel`, `list`:

```ts
import { Mill } from "@mill/core";
await Mill.submit(programPath);
```

Default Layer is `Mill.Default` (Effect v4 idiom). Test/mock layers sit alongside (`Mill.Test`, etc.).

The brand and the central type share a name on purpose, matching the Effect ecosystem convention (`Effect`, `Cluster`, `SqlClient`). Internal services (`TaskEntity`, `EventAppender`, `EntityRegistry`, …) keep narrow role names; Mill is the composer.

The word "operator" stays lowercase, prose-only, meaning "the human running `mill` from a terminal."

## Decisions captured

- **2026-05-04 — Collapse Run + Task into Task.** No `RunEntity`/`TaskEntity` split, no `runId`/`taskId` split. Storage path: `~/.mill/tasks/<taskId>/`. Schemas: `TaskRecord`, `TaskResult`, `TaskStatus`. Top-level disambiguation uses "program task". Rationale: the data model is already unified; vocabulary follows. (Rewrite, no backwards compat — operator-side cost of dropping "run" the noun is a one-time onboarding cost.)
- **2026-05-04 — Three-layer naming for the runtime entity.** Public type `Task` (handle), internal type `TaskEntity` (Cluster-compatible), conceptual framing "actor-style." Word "actor" is not a type name anywhere. `TaskActor` removed; `task-actor.api.ts` → `task.api.ts`, `TaskActor` → `Task`.
- **2026-05-04 — Past-tense events.** All event names are past-tense facts (`task:created`, `task:started`, `task:turn_started`, `task:turn_completed`, `task:completed`, `task:failed`, `task:cancelled`, `task:child_spawned`, `task:tool_called`, `task:tool_returned`). Reason: events are journaled facts, not requests; commands are imperative (`SendMessage`, `CompleteTask`), events are past-tense (`task:started`). Avoids grep collisions and matches event-sourcing convention.
- **2026-05-04 — Full event sourcing for chunks.** Streaming content (`task:message_chunk`, `task:thought_chunk`) is journaled in `events.ndjson` alongside lifecycle events. State is fully reconstructible from the event log alone. Single channel, single reducer, single watch. Accepted cost: large event files for long agent responses.
- **2026-05-04 — Created and started are distinct lifecycle events.** A task can sit in `created` state (registered with parent, awaitable, cancellable, no work yet) before transitioning to `started`. The first `send()` implicitly emits `task:started`; there is no public `start()` ceremony. This preserves the lifecycle distinction for validation and replay while giving program authors a single prompt-delivery verb.
- **2026-05-04 — Closed event vocabulary.** Final event set: `task:created`, `task:started`, `task:turn_started`, `task:message_chunk`, `task:thought_chunk`, `task:turn_completed`, `task:child_spawned` (parent log only), `task:tool_called`, `task:tool_returned`, `task:completed`, `task:failed`, `task:cancelled`. Turn boundary events carry the prompt and per-turn result; message/thought chunks remain output streams. No `task:milestone` (provider chatter dropped — default runs with permissions allowed, so no `permission_requested`). No `task:plan` (plans are tool calls in practice). Children's existence appears in the parent's log via `task:child_spawned`; the child's own log starts with `task:created`.
- **2026-05-04 — Commands vs Queries split (CQRS).** Two vocabularies, not one. **Commands** (mailbox-routed, serial, mutate state): `CreateTask({ parentId?, kind, input })`, `SendMessage({ id, message })`, `CompleteTask({ id })`, `CancelTask({ id, reason? })`. **Queries** (reads, parallel): `GetTask({ id })`, `GetSubtree({ rootId })`, `AwaitTask({ id })`, `WatchTask({ id, fromSeq? })`. Spawning is creating-with-parent (no separate `SpawnChildTask`). The first `SendMessage` starts the task and buffers prompt delivery to the runtime. `CancelTask` is a structural command, not a steering message.
- **2026-05-04 — Steering modes: queue and interrupt only.** Dropped `reject`. `queue` (default, append to mailbox) and `interrupt` (stop current turn) are sufficient. Reject-if-busy is rare in practice; callers who want it can `GetTask` first.
- **2026-05-04 — Snapshot keeps text/thought projections.** Even with chunks as events, the reducer folds chunks into `text` and `thought` strings on the snapshot. For agent tasks, `text` is per-turn: it clears on `task:turn_started` and accumulates chunks for the current turn; completed turns are preserved in `history`. Completed snapshots also expose `output` for the terminal success payload; failed/cancelled errors travel through `TaskResult`/terminal errors instead of snapshot fields. Subscribers consume the projection rather than implementing the fold. This is the textbook role of projection.
- **2026-05-04 — Lifecycle status enum: 5 values.** `created | started | completed | failed | cancelled`. Steering substate moves out of `status` into dedicated fields (`pending`, `busy`). Separates lifecycle question ("where is this task?") from mailbox question ("is something buffered?"). Dropped from prior enum: `idle` (was created), `starting` (transient), `running` (was started), `waiting`, `queued`, `interrupting`.
- **2026-05-04 — CLI surface adapts to task vocabulary.** All `<runId>` args become `<taskId>`. `mill run` creates a program task and prints `taskId`. `mill ls` defaults to root program tasks (`--all` for everything). `mill watch <taskId>` defaults to subtree (`--shallow` to scope). `mill cancel <taskId>` cascades. Drops `--channel events|io|all` (chunks are events; replaced by `--include`/`--exclude` for subsetting). Drops `--source agent|program` (filter by kind via `--kind` or walk subtree).
- **2026-05-04 — Storage layout: flat per root.** `~/.mill/tasks/<taskId>/` exists only for root program tasks. Children's events live in the *same* `events.ndjson` as the root, keyed by `taskId` per event. Single log per tree means single-file tail for `mill watch`, single replay for recovery. `tasks/<childId>.json` subdir holds projected snapshots per child for quick lookup without scanning the full log.
- **2026-05-04 — No OTP supervision names yet.** Default behavior (parent cancellation cascades, child failure doesn't fail parent unless awaited) is implicit; not named. If/when explicit policies arrive, they get plain-English names (`cascade_cancel`, `isolate_failures`), not OTP imports (`one_for_one`, `rest_for_one`).
- **2026-05-04 — `AgentProvider` → `Agent`.** Public-facing type renamed. From a program author's view, `codex(...)` returns an agent, not a "provider." `AgentRegistry` (resolves agents to runtimes) and `AgentRuntime` (interface for implementations) remain internal.
- **2026-05-04 — Top-level service is `Mill`, with Layer `Mill.Default`.** Brand and central abstraction share a name (Effect ecosystem convention: `Effect`, `Cluster`, `SqlClient`). Composes registry/store/path/id-gen; exposes `submit`/`status`/`wait`/`watch`/`cancel`/`list`. Effect v4 Layer convention (`Mill.Default`) over older `MillLive`. Earlier `Operator` proposal rejected — created a confusing 3-way overload with the package name and the human-CLI-user sense; brand-as-service collapses cleanly into one concept.
- **2026-05-04 — Folder-based file layout, suffix conventions retired.** Rewrite-time switch (before/after, no hybrid). Top-level holds `index.ts`, `*.api.ts` for public boundaries, and pure-function modules (`task-reducer.ts`, `ids.ts`). `schemas/` holds *only* Schema definitions (`task-command.ts`, `task-event.ts`, `task-state.ts`, `supervision.ts`). `services/` holds modules with Effect Layers, PascalCase (`Mill.ts`, `TaskEntity.ts`, `EventAppender.ts`, …). `*.effect.ts` and `*.schema.ts` suffixes removed; `lint:boundary` and the toolchain reference doc need updating to match at rewrite time.
