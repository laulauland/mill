# 0001 — Repository Foundation (Active)

## Goal

Implement the baseline monorepo scaffold and guardrail toolchain for `mill` per SPEC sections 8.6 and 19.

## Scope

- Bun workspace monorepo with:
  - `packages/core`
  - `packages/cli`
  - `packages/driver-pi`
  - `packages/driver-claude`
  - `packages/driver-codex`
- Baseline Effect dependencies (`effect`, `@effect/platform`, `@effect/platform-bun`, `@effect/schema`)
- Constraint toolchain files/scripts
- Minimal compileable package wiring + baseline tests
- Docs split from `SPEC.md` into cedar-style `docs/` tree

## Exit criteria

- `bun install` succeeds
- baseline checks pass (`format:check`, lint config/rules, `bun test`)
- docs indexes and root guidance files exist

## Notes

This plan establishes foundations only; engine/driver execution semantics are follow-on implementation phases.
