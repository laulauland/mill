# Code style

## Platform effects

Prefer Effect platform services over direct platform APIs in runtime code.

- Use `effect/FileSystem` and `effect/Path` instead of `node:fs`, sync fs calls, or `node:path`.
- Use `effect/unstable/process/ChildProcess` with `@effect/platform-bun/BunServices.layer` instead of `node:child_process`, `Bun.spawn`, or raw `process.kill`.
- Keep CLI entrypoints thin: parse args, compose Effects/Layers, and delegate platform work to small Effectful helpers or services.
- If a direct platform API is unavoidable, isolate it in an explicit final-boundary adapter and document why Effect's platform API is insufficient.

Guardrails for these rules live under `.ast-grep/rules/`, including `no-node-imports`, `no-node-child-process`, `no-sync-fs`, and `no-bun-globals`.
