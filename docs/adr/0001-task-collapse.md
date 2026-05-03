# 0001 — Collapse Run and Task into a single Task entity

Date: 2026-05-04
Status: accepted

## Context

Mill v0 had two distinct entity types:

- `Run` — a durable program execution. Storage path `~/.mill/runs/<runId>/`. Public CLI surface: `mill status <runId>`, `mill cancel <runId>`. Schemas: `RunRecord`, `RunResult`, `RunStatus`. Identifier: `runId`.
- `Task` — one delegated unit of agent work, child of a run. Schemas: `TaskOptions`, `TaskResult`. Identifier: `taskId`.

These shared most of their lifecycle (created, running, terminal), most of their event vocabulary (`run:start` and `task:start` were near-identical facts), and most of their storage shape (events, results, projection). The split duplicated reducer logic, event vocabularies, and command handling.

The rewrite is ground-up with no backwards compatibility constraint.

## Decision

Collapse `Run` and `Task` into a single **task** entity with a `kind` discriminator: `program | agent` (extensible to `shell | http | workflow | composite`). The "run" concept disappears as a noun; "run" survives only as the CLI verb (`mill run <program.ts>` = "execute this program").

- Identifier: `taskId` everywhere. No `runId`.
- Storage: `~/.mill/tasks/<taskId>/`. Only root tasks (`kind === program`) get a directory; the whole subtree's events live in one `events.ndjson`.
- Schemas: `TaskRecord`, `TaskResult`, `TaskStatus`, no `Run*` types.
- Top-level disambiguation in prose: "program task" (e.g., *"the program task completed; 3 child tasks remain pending"*).
- Internally, the field name `rootTaskId` is permitted in tree-walking code; it is the same value as the public `taskId` of the root task.

## Alternatives considered

**Keep both, with `runId` an alias for `rootTaskId`.** Rejected — half-unification keeps both costs (two words to teach, alias rule to maintain) without simplifying the data model. Without compat, no reason to carry the aliasing.

**Delete "run" the verb too** (e.g., `mill exec`, `mill start`). Rejected — the verb form reads naturally and is universally understood. Only the noun is ambiguous.

## Consequences

- Every public surface uses `taskId`. CLI flags, JSON output keys, schema fields, on-disk paths, error messages.
- Operators previously typing `<runId>` now type `<taskId>`. One-time onboarding cost; no ongoing maintenance.
- The event vocabulary collapses from `run:*` + `task:*` into `task:*` only (see ADR 0002).
- The supervision tree has a single uniform model: every node is a task; the root has no parent.
- Forward compat with `effect/unstable/cluster`: `TaskEntity` maps 1:1 to a Cluster `Entity`, regardless of kind.
