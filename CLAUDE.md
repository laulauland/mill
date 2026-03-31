# CLAUDE.md

## Docs navigation

- Primary index: `docs/indexes/docs.index.md`
- Product spec split: `docs/product-specs/mill-v0-product-spec.md`
- Design contracts split: `docs/design-docs/mill-v0-architecture-and-boundaries.md`
- Guardrail/toolchain reference: `docs/references/mill-v0-toolchain-and-invariants.md`

## Where implementation guidance lives

- Use `docs/exec-plans/active/` for current execution steps.
- Move finished plans to `docs/exec-plans/completed/` with outcomes.

## Boundary policy

- Public API boundary: `*.api.ts` plus flat entry files such as `index.ts`, `types.ts`, `test-runtime.ts`, and CLI `mill.ts`
- Domain contracts: `*.schema.ts`
- Internal/runtime orchestration: `*.effect.ts`
