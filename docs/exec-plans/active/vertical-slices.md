# Active vertical slices

This document tracks the current v0 slices after the config-free imported program API refactor. Older config/discovery/provider-selection milestones were superseded by the current design.

## S1 — Imported program API

Status: complete.

Intent: programs import from `@mill/core/program`, create task actors with `task(...)`, and use top-level await for completion.

Acceptance:

- `import { task, codex } from "@mill/core/program"` works in CLI-run programs.
- No normal core/CLI authoring path requires a global `mill`.
- Calling program helpers outside a hosted context fails clearly.

## S2 — Config-free CLI execution

Status: complete.

Intent: `mill run program.ts` works without a config file. Programs select providers directly with `codex(...)`, `claude(...)`, or `pi(...)`.

Acceptance:

- No config file is required for built-in providers.
- CLI lifecycle commands remain `run`, `status`, `wait`, `watch`, `cancel`, and `ls`.
- Provider-selection is expressed in the program, not through CLI provider flags.

## S3 — Task-native persistence

Status: complete.

Intent: persisted run artifacts use task vocabulary.

Acceptance:

- Event records use `task:*` events and `taskId`.
- Run results expose `tasks`.
- `watch --task <taskId>` filters task IO/events where applicable.

## S4 — Effect/platform hygiene

Status: active hardening.

Intent: internals remain Effect-first, IO stays at explicit platform edges, and errors are tagged/handled.

Acceptance:

- Core/CLI avoid direct Node/Bun platform calls outside approved edges.
- Effect/Promise bridging occurs only at public boundaries.
- Guardrails catch stale platform and Promise patterns.

## S5 — Pi-mill alignment

Status: partially complete.

Intent: pi-mill exposes an extension-specific serialized task shape while generating core-compatible mill programs internally.

Acceptance:

- Pi-mill docs clearly distinguish its `mill.task({ agent: label, model, ... })` shape from core `task({ agent: codex(model), ... })` programs.
- Runtime/platform cleanup for pi-mill remains a separate hardening slice.
