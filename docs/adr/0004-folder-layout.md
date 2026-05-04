# 0004 — Folder-based file layout, suffix conventions retired

Date: 2026-05-04
Status: accepted

## Context

Mill v0 used a suffix-based file naming convention, documented in `CLAUDE.md` and `docs/references/mill-v0-toolchain-and-invariants.md`:

- `*.api.ts` — public Promise/actor wrappers and package APIs.
- `*.effect.ts` — Effect-native internal programs/services.
- `*.schema.ts` — schemas and persisted/domain shape.
- `*.codec.ts` — decode/encode helpers.

A flat `packages/<pkg>/src/` directory held everything; role was visible in every filename. The `lint:boundary` ast-grep rule enforced this convention.

The rewrite plan introduced a folder-based structure:

```
packages/core/src/
  index.ts
  *.api.ts                  (top-level public)
  schemas/                  (Schema definitions)
  services/                 (Effect Layers, PascalCase)
```

These conventions are mutually exclusive. Choosing one over the other is a deliberate change to project guardrails.

## Decision

Adopt the folder-based layout. Retire `*.effect.ts` and `*.schema.ts` suffixes. Rewrite-time switch — there is no hybrid window; v0 layout is replaced wholesale.

Layout:

- Top level — `index.ts`, `*.api.ts` for public boundaries, pure-function modules (`task-reducer.ts`, `ids.ts`).
- `schemas/` — _only_ Schema definitions (`task-command.ts`, `task-event.ts`, `task-state.ts`, `supervision.ts`).
- `services/` — Effect Layers, PascalCase (`Mill.ts`, `TaskEntity.ts`, `EventAppender.ts`, etc.).

`*.api.ts` survives because it marks the public surface of the package — orthogonal to the internal folder split.

## Alternatives considered

**(II) Keep suffix convention; drop the folder structure.** `services/TaskEntity.ts` becomes top-level `task-entity.effect.ts`; `schemas/task-command.ts` becomes top-level `task-command.schema.ts`. Suffixes give cross-cutting role visibility (any grep includes the role); flat directories scale linearly.

Rejected because the rewrite is a full restart and we want the file structure to express the entity-vs-schema-vs-public-surface split visibly. The suffix convention added value when files were intermixed; with deliberate folder placement, it becomes redundant signal. PascalCase service files also match Effect ecosystem aesthetic (services-as-modules with default Layers).

**(III) Hybrid — `services/task-entity.effect.ts`.** Folder _and_ suffix. Rejected as repeat-yourself; folder placement already says "this is an Effect service."

## Consequences

- `lint:boundary` ast-grep rule must be rewritten — currently enforces suffix; will need to enforce folder placement (no Effect Layers outside `services/`, no Schema definitions outside `schemas/`).
- `CLAUDE.md` and `AGENTS.md` boundary policy updated to describe the new layout.
- `docs/references/mill-v0-toolchain-and-invariants.md` deleted; spec.md carries the toolchain rules now.
- Code editors / file pickers benefit from semantic grouping (e.g., "open all services").
- Cross-cutting search (`grep`-by-role) loses the suffix hint; users grep by folder path instead.
- New contributors learn one rule per folder rather than memorizing four suffixes.
