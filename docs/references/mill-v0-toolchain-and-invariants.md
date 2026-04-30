# mill v0 toolchain and invariants

## Toolchain

Core stack:

- TypeScript
- Bun for workspace scripts and compiled CLI builds
- Effect v4 / effect-smol for internals
- Effect platform services at IO boundaries
- Schema modules for persisted/domain validation
- ast-grep + oxlint + oxformat + tsgo for checks

Required validation:

```bash
bun run lint:exports
bun run typecheck
bun run lint:ast-grep
bun run check
```

## File boundaries

- `*.api.ts`: public Promise/actor wrappers and package APIs.
- `*.effect.ts`: Effect-native internal programs/services.
- `*.schema.ts`: schemas and persisted/domain shape.
- `*.codec.ts`: decode/encode helpers.
- package `src/index.ts`: public export boundary.

Production code should keep IO at explicit platform edges, use tagged errors, and avoid Effect/Promise ping-pong.

## Runtime invariants

1. Programs import from `@mill/core/program`.
2. Normal core/CLI authoring does not depend on a global `mill`.
3. Built-in providers are selected in program code with `codex(model)`, `claude(model)`, or `pi(model)`.
4. There is no config file requirement for normal execution.
5. `mill run` is async by default and returns a durable `runId`.
6. Every run has exactly one terminal state.
7. Every task actor has exactly one terminal outcome.
8. Persisted orchestration records use task vocabulary.
9. Snapshots are reduced current state; events are append-only facts.
10. ACP/session implementation details remain internal to built-in provider runtime packages.

## Non-goals

- Config-file based provider selection.
- Public imports from internal ACP implementation packages.
- Shell-string process execution.
- Live model discovery during normal help rendering.
