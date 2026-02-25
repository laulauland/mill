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

## Commits

Use conventional commits. The changelog is generated from these prefixes:
- `feat:` / `fix:` / `refactor:` / `perf:` / `docs:` / `chore:` / `style:`
- Scoped prefixes are fine: `feat(core): add persistence layer`
- `chore(release):` and `release:` commits are excluded from the changelog

## Releasing

Binary: `mill`. CLI entrypoint: `packages/cli/src/bin/mill.ts`. Version lives in `packages/cli/package.json`.

To cut a release:
1. Bump version in `packages/cli/package.json`, commit: `chore(release): vX.Y.Z`
2. Push to main, then tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`
3. CI compiles standalone binaries via `bun build --compile`, generates changelog, creates GitHub release, and updates the Homebrew formula in `laulauland/homebrew-tap`

Requires `TAP_GITHUB_TOKEN` repo secret (PAT with write access to `laulauland/homebrew-tap`).
