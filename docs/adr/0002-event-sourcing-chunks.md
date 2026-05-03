# 0002 — Streaming chunks are first-class events

Date: 2026-05-04
Status: accepted

## Context

Mill v0 had a two-tier observability model:

- **Tier 1** — structured events (`task:start`, `task:milestone`, `task:tool_call`, `task:complete`, …) persisted to `events.ndjson`.
- **Tier 2** — line-oriented stdout/stderr passthrough on the "io" channel, available via `mill watch --channel io`.

Streaming agent output (running message text, thought stream) lived in Tier 2. The event log captured lifecycle and structural facts; the IO channel carried bytes.

The rewrite reframes the event log as the single source of truth for state reconstruction (per the entity-model framing in ADR 0001). That raises the question: where do streaming chunks live?

## Decision

Chunks are first-class events. `task:message_chunk` and `task:thought_chunk` are journaled in `events.ndjson` alongside lifecycle events. State (including in-progress `text` and `thought`) is fully reconstructible from the event log alone.

- Single channel — no `--channel events|io|all` flag in CLI; replaced by `--include` / `--exclude` for subsetting.
- Single reducer — folds chunks into `snapshot.text` / `snapshot.thought` projections.
- Single watcher — `mill watch <taskId>` tails one file.
- The `--source agent|program` distinction also disappears — events are tagged with their originating `taskId`, which has a `kind`. Filter by kind, or by walking the subtree.

## Alternatives considered

**Two-tier model preserved.** Structural events in `events.ndjson`; chunks in a sibling `chunks.ndjson` or as raw stdout/stderr passthrough. Snapshots reconstruct text from the chunks file at read time, or rely on a live observer projection while running.

Rejected for simplicity. The two-tier model has real merits — `events.ndjson` stays small and grep-friendly, storage scales with lifecycle rather than output volume — but it splits the reducer, splits the watch, and splits the recovery story. The unified model is easier to reason about and matches the Cluster forward-compat goal (Cluster entities are event-sourced).

## Consequences

- `events.ndjson` grows with output volume. A long agent response can produce thousands of chunk events. This is the explicit cost.
- Operators running `mill watch <taskId>` on a long-running task get a high-volume stream. Default UX adds `--exclude chunks` for a structural-only view; full firehose is opt-in.
- File size on disk is dominated by chunk content. Future optimization: gzip closed event files, or rotate per task. Out of scope for v1 rewrite.
- `task:milestone` is removed entirely. Its prior uses (provider config noise, mode changes, available-commands) are dropped from the event log; what remains structural (tool calls/results, child spawning) gets its own first-class event.
- `--channel` / `--source` flags removed from `mill watch`. Replaced by `--include` / `--exclude` / `--shallow` / `--kind`.
