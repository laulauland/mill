# Mill docs

This tree describes Mill **as it will be after the rewrite**. The shipped v0 code lives in the working tree but is being replaced wholesale; do not treat existing source as authoritative for the new design.

## Read in this order

1. `/CONTEXT.md` (repo root) — canonical glossary; the language used everywhere else.
2. `docs/spec.md` — target shape of Mill: model, public API, commands, events, storage, CLI, package layout, invariants.
3. `docs/rewrite-plan.md` — implementation roadmap (10 phases).
4. `docs/adr/` — load-bearing decisions with full context and trade-offs.

## ADR index

- `adr/0001-task-collapse.md` — Run + Task collapsed into one entity.
- `adr/0002-event-sourcing-chunks.md` — streaming chunks are first-class events.
- `adr/0003-cqrs-split.md` — commands and queries are separate vocabularies.
- `adr/0004-folder-layout.md` — folder-based layout replaces suffix conventions.

## Execution plans

- `exec-plans/active/` — current implementation tracks (one plan per phase or feature).
- `exec-plans/completed/` — archived plans with outcomes.
