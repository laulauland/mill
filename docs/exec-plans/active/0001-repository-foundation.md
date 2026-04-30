# 0001 — Repository Foundation (Active)

## Goal

Implement the baseline monorepo scaffold and guardrail toolchain for `mill` per SPEC sections 8.6 and 19.

## Scope

- Bun workspace monorepo with:
  - `packages/core`
  - `packages/cli`
  - built-in ACP provider runtime package
- Baseline Effect v4 dependencies (`effect`, `@effect/platform-bun`)
- Constraint toolchain files/scripts
- Minimal compileable package wiring + baseline tests
- Docs split from `SPEC.md` into cedar-style `docs/` tree

## Exit criteria

- `bun install` succeeds
- baseline checks pass (`format:check`, lint config/rules, `bun test`)
- docs indexes and root guidance files exist

## Notes

This plan establishes foundations only; task actor execution semantics are follow-on implementation phases.
