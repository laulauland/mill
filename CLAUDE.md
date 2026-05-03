# CLAUDE.md

## Read first

- `/CONTEXT.md` — canonical glossary and decisions log.
- `docs/spec.md` — target shape of Mill (post-rewrite).
- `docs/rewrite-plan.md` — implementation roadmap.
- `docs/adr/` — load-bearing design decisions.

## Status

Mill is being rewritten ground-up. The shipped v0 source under `packages/` does not match the docs in `docs/spec.md` — the docs describe the target. Do not treat existing source as authoritative for the new design.

## Where implementation guidance lives

- `docs/exec-plans/active/` — current execution steps.
- `docs/exec-plans/completed/` — archived plans with outcomes.

## File layout (post-rewrite)

- `packages/<pkg>/src/index.ts` — public export boundary.
- `packages/<pkg>/src/*.api.ts` — public API wrappers.
- `packages/<pkg>/src/schemas/` — Schema definitions only.
- `packages/<pkg>/src/services/` — Effect Layers, PascalCase modules.
- Top-level pure-function modules (e.g. `task-reducer.ts`, `ids.ts`) live next to `index.ts`.

The `*.effect.ts` and `*.schema.ts` suffixes are retired. See `docs/adr/0004-folder-layout.md`.
