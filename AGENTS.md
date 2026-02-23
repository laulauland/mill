# AGENTS.md

## Source of truth

- Product and architecture constraints are split from `SPEC.md` under `docs/`.
- Start with `docs/indexes/docs.index.md`.

## Implementation guidance location

- Product requirements: `docs/product-specs/`
- Architecture and boundary contracts: `docs/design-docs/`
- Toolchain + guardrails + invariants: `docs/references/`
- Active execution plan: `docs/exec-plans/active/`

## Guardrail reminder

- Respect file boundary naming (`public/*.api.ts`, `domain/*.schema.ts`, `internal/runtime/*.effect.ts`).
- Use only public package exports across packages.
