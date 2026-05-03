# Mill rewrite plan

Implementation roadmap for the supervised task-entity runtime. Read alongside `/CONTEXT.md` (language) and `docs/spec.md` (target shape).

This is a ground-up rewrite. There is no compatibility layer with the prior `RunRecord`/`TaskActor` shape — the goal is a clean replacement.

## Phases

### 1. Architecture spec

Land `docs/spec.md` and `/CONTEXT.md` as authoritative. Wire ADRs in `docs/adr/` for the load-bearing decisions: task-entity unification, event-sourcing for chunks, CQRS split, folder layout. No code changes.

### 2. Define the domain

In `packages/core/src/schemas/`:

- `task-command.ts` — `CreateTask`, `StartTask`, `SendMessage`, `CancelTask`.
- `task-event.ts` — full past-tense event vocabulary (`task:created` … `task:cancelled`).
- `task-state.ts` — `TaskState`, `TaskSnapshot`, status enum, `pending`/`busy` mailbox fields.
- `supervision.ts` — supervision-related types (default policy is implicit; placeholder for future explicit policies).

Plus `packages/core/src/task-reducer.ts` — pure reducer over events. Plus `packages/core/src/ids.ts` — id helpers.

### 3. Build EventAppender

Service in `packages/core/src/services/EventAppender.ts`:

- Owns event sequence numbers per root.
- Validates lifecycle transitions before append.
- Appends to `~/.mill/tasks/<rootTaskId>/events.ndjson`.
- Publishes appended events to a PubSub for live watchers.
- Updates child snapshot files (`tasks/<childId>.json`) as a projection side-effect.

### 4. Local TaskEntity host

Service in `packages/core/src/services/TaskEntity.ts`:

- One running fiber per active task.
- Sequential command handler (queue-driven, mailbox semantics).
- State projection via the reducer.
- Child spawning emits `task:child_spawned` on the parent's log and `task:created` on the child's view.
- Await/watch/cancel resolved against the entity's state and event stream.
- Shape kept compatible with `effect/unstable/cluster` `Entity` (intentional 1:1).

`packages/core/src/services/EntityRegistry.ts` holds active entities and resolves by `taskId`.

### 5. Mill service

Service in `packages/core/src/services/Mill.ts`:

- `submit(programPath)` — creates root program task; returns `taskId`.
- `status(taskId)` — current snapshot.
- `wait(taskId, timeout?)` — terminal status.
- `watch(taskId, opts?)` — event stream.
- `cancel(taskId, reason?)` — cascades.
- `list({ all? })` — root tasks (or full set with `--all`).

`Mill.Default` Layer composes the above.

### 6. Program host

Service in `packages/core/src/services/ProgramHost.ts`:

- Dynamic-imports the program file under a `ProgramContext`.
- Binds `task(...)` from `@mill/core/program` to the current parent task (the program task on first call; child task on nested calls if any).
- The root program task wraps module evaluation: completes when top-level await resolves and any awaited children settle.
- Captures stdout/stderr; chunks become `task:message_chunk` / `task:thought_chunk` events.

### 7. Public APIs

- `@mill/core` — Effect-native (exports `Mill`, schemas, types).
- `@mill/core/program` — program authoring (`task`, `codex`, `claude`, `pi`, `Agent` type).
- `@mill/core/runtime` — Promise facade (`createMillRuntime`).

### 8. CLI rewrite

`packages/cli/src/` per the file-layout in spec.md. Small, focused files. Real JSON and text rendering. No dead flags. All `<taskId>` (no `<runId>`). `--include`/`--exclude` for subsetting events. `--shallow` to scope. `mill ls` defaults to roots; `--all` for full tree.

### 9. Provider rewrite

`packages/provider-acp/src/` — scoped ACP sessions, provider-event-to-task-event mapping, clean process config. PascalCase module names per spec.md.

### 10. Tests

Per layer:

- Pure reducer (no Effect).
- EventAppender integration (sequence, validation, file output, pubsub).
- TaskEntity supervision (cascade cancel, child spawn, await).
- ProgramHost (module evaluation, ProgramContext binding, completion semantics).
- CLI lifecycle (golden-path against fixture programs).
- Provider fixtures (ACP runtime tested against recorded transcripts).

## Toolchain follow-ups

These conflict with the rewrite and must be updated as the rewrite lands:

- `lint:boundary` (ast-grep rule) — currently enforces `*.effect.ts`/`*.schema.ts` suffix; needs rewriting to enforce `services/`-and-`schemas/` folder placement instead.
- `AGENTS.md` boundary reminders — already updated.
- `CLAUDE.md` boundary policy — already updated.

## North star

> Mill is an Effect-native supervised task runtime. A program is a root task; every delegated agent call is a child task. Tasks are addressable entities with typed commands, sequential handlers, durable past-tense event facts, projected snapshots, and supervision relationships.
