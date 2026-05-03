# 0003 — CQRS split for the entity API

Date: 2026-05-04
Status: accepted

## Context

The first draft of the rewrite plan listed nine "commands" as one family:

```
CreateTask, StartTask, SpawnChildTask, SendTaskCommand,
CancelTask, GetTask, GetSubtree, AwaitTask, WatchTask
```

This list mixed three distinct shapes:

1. State-changing imperatives (`CreateTask`, `StartTask`, `CancelTask`, `SendTaskCommand`).
2. Pure reads (`GetTask`, `GetSubtree`).
3. Async observation (`AwaitTask`, `WatchTask`).

It also contained two redundancies:

- `SpawnChildTask` overlapped with `CreateTask` — spawning is creating-with-parent.
- `SendTaskCommand` was a recursive name (a command that wraps another command).

In Effect Cluster, commands route through the entity mailbox and serialize per entity; queries can run in parallel. Lumping reads and writes into one family blurs that distinction.

## Decision

Split the entity API into two vocabularies.

**Commands** — mailbox-routed, serial, mutate state, produce events:

```
CreateTask({ parentId?, kind, input })   →  task:created
StartTask({ id })                         →  task:started
SendMessage({ id, message })              →  no structural event; payload-dependent
CancelTask({ id, reason? })               →  task:cancelled
```

**Queries** — reads, parallel, never mutate:

```
GetTask({ id })            →  current snapshot
GetSubtree({ rootId })     →  recursive snapshot
AwaitTask({ id })          →  resolves on terminal status
WatchTask({ id, fromSeq? }) → stream of events
```

Spawning is `CreateTask` with `parentId` set. `SendTaskCommand` is renamed `SendMessage` — the entity has a mailbox; you send messages. `CancelTask` stays a top-level command (cancellation is supervision-level, not a steering message).

## Alternatives considered

**Single command family.** Match Cluster's "one message type per entity" pattern at the type-system level. Rejected: even when the on-the-wire message is one union, splitting Command and Query halves at the API surface gives better ergonomics (parallel-safe reads, explicit serial writes) without losing Cluster compatibility — the union can still be reconstructed for transport.

**Fold cancel into `SendMessage`.** A single mailbox API reads simpler. Rejected: cancellation is structurally important enough to surface as its own command, matches the existing `task.cancel()` method on the public handle, and gives the supervision system a clean hook point.

## Consequences

- Internal command-handler types are smaller; reducer can be split into command-handler and query-handler halves.
- Public handle methods map 1:1 to commands: `task.start()` → `StartTask`; `task.cancel()` → `CancelTask`; `task.send()` → `SendMessage`. Queries are accessed via `Mill.status` / `Mill.watch` / etc., not via the handle.
- Tests can target reducers (pure) and command-handlers (with services) separately.
- Adding new commands or queries is additive; the split keeps growth pressure off the wrong half.
