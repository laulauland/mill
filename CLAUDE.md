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

- Public API boundary: `src/public/**` and `*.api.ts`
- Domain contracts: `src/domain/**` and `*.schema.ts`
- Internal/runtime orchestration: `src/internal/**`, `src/runtime/**`, `*.effect.ts`
