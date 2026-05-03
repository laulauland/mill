# AGENTS.md

## Source of truth

- `/CONTEXT.md` — canonical glossary and decisions log.
- `docs/spec.md` — target shape of Mill (post-rewrite).
- `docs/rewrite-plan.md` — implementation roadmap.
- `docs/adr/` — load-bearing decisions.

The shipped v0 source under `packages/` is being replaced ground-up; the docs above describe the target, not the current code.

## Implementation guidance location

- Active execution plan: `docs/exec-plans/active/`
- Completed plans: `docs/exec-plans/completed/`

## File layout (post-rewrite)

- Public API: `*.api.ts` plus `index.ts` (the package's export boundary).
- Schema definitions: `schemas/` folder.
- Effect services / Layers: `services/` folder, PascalCase modules.
- Pure-function modules (reducers, id helpers): top level next to `index.ts`.
- Suffixes `*.effect.ts` and `*.schema.ts` are retired (see `docs/adr/0004-folder-layout.md`).

## Commits

Use conventional commits. The changelog is generated from these prefixes:

- `feat:` / `fix:` / `refactor:` / `perf:` / `docs:` / `chore:` / `style:`
- Scoped prefixes are fine: `feat(core): add persistence layer`
- `chore(release):` and `release:` commits are excluded from the changelog

## Releasing

Binary: `mill`. CLI entrypoint: `packages/cli/src/mill.ts`. Version lives in `packages/cli/package.json`.

To cut a release:

1. Bump version in `packages/cli/package.json`, commit: `chore(release): vX.Y.Z`
2. Push to main, then tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`
3. CI compiles standalone binaries via `bun build --compile`, generates changelog, creates GitHub release, and updates the Homebrew formula in `laulauland/homebrew-tap`

Requires `TAP_GITHUB_TOKEN` repo secret (PAT with write access to `laulauland/homebrew-tap`).
