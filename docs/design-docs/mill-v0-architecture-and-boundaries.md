# mill v0 Architecture and Boundaries

_Source: `SPEC.md`, Sections 8–18._

## Boundary model

Mill is Effect v4 / effect-smol-first internally and Promise-friendly at public boundaries.

- Public boundary files (`*.api.ts`, `src/index.ts`, `src/types.ts`, CLI entry adapters) may expose interfaces and Promise-returning APIs.
- Internal runtime files (`*.effect.ts`) use `Effect`, `Stream`, `Layer`, `Ref`, and other Effect primitives.
- Domain persistence files (`*.schema.ts`) define persisted data with `effect/Schema`.
- Decode/encode files (`*.codec.ts`) own ad-hoc wire parsing.

Only `Effect.runPromise` may bridge Effect to Promise, and only at public boundaries. Today the main Promise surfaces are task actor `.done` and runtime facade methods. Future Effect-native APIs should be additive.

## Public task actor API

Authored mill programs use task actors:

```ts
import { codex } from "@mill/core";

const task = mill
  .task({
    agent: codex("openai-codex/gpt-5.3-codex"),
    system: "You inspect code.",
    prompt: "Review src/auth.",
  })
  .start();

return await task.done;
```

Provider factories are pure data constructors exported by `@mill/core`:

```ts
codex("openai-codex/gpt-5.3-codex");
claude("anthropic/claude-opus-4-6");
pi("your-pi-model-id");
```

`agent` chooses driver/model. `role` is optional human-facing task identity. `system` describes behavior. `prompt` describes the requested work.

## Task actors, snapshots, and events

A task actor exposes:

- `start()` to begin work
- `send(command)` for steering intent
- `cancel(reason?)` / `stop()` for cancellation intent
- `subscribe(listener)` for snapshot updates
- `getSnapshot()` for current state
- `done` for final result

Events are append-only facts persisted in `events.ndjson`. Snapshots are current reduced state derived from actor state/events: status, accumulated text, queued commands, session pointer, terminal result, or error.

Current task statuses are:

```text
idle -> starting -> running -> waiting -> complete
                         |        |       -> failed
                         |        |       -> cancelled
                         |        -> queued
                         -> interrupting
```

This diagram is descriptive; implementations may skip intermediate statuses when work completes quickly.

## Steering status

Core actor snapshots model three policies:

- `queue`: record the command for the next turn when the task is busy
- `interrupt`: move toward interrupting/cancelling the active turn before applying the command
- `reject`: reject commands that cannot be applied immediately

Current limitations are intentional and documented:

- Program-host task actors expose the actor shape and snapshot transitions for authored programs.
- `@mill/driver-acp` has session-level multi-turn/cancel support through internal `spawn-agent` integration.
- Durable end-to-end steering from a running program through the run store into a live ACP session is still incremental.

## Runtime topology

```text
mill program (TS)
  -> executor (direct | vm)
    -> engine (run lifecycle, task API injection, events, persistence)
      -> driver (generic)
        -> agent process / remote endpoint

engine events -> watch/tui/automation
```

Executor, driver, extension, and observer layers remain orthogonal.

## Driver boundary

Core does not encode vendor semantics. Drivers translate task execution into agent protocol work.

`@mill/driver-acp` is the built-in ACP driver package for Claude, Codex, and pi. It uses `spawn-agent` internally for ACP v1 process/session handling, model config options, cancellation, and multi-turn session support. `spawn-agent` is not part of the public mill API.

Static model catalogs remain the source for normal CLI help. Live ACP config/model discovery should be explicit if added later, because it creates sessions.

## CLI and runtime facade

CLI lifecycle commands remain:

```bash
mill run <program.ts> [--sync] [--json]
mill status <runId> [--json]
mill wait <runId> --timeout <seconds> [--json]
mill watch [--run <runId>] [--channel events|io|all] [--json]
mill cancel <runId> [--json]
mill ls [--json]
```

Internally the CLI should stay a thin wrapper over the runtime facade / actor-compatible boundaries, while preserving terminal UX and JSON contracts.

## Storage/event vocabulary

Public docs use task vocabulary. Some persisted event and storage names still use historical `spawn:*` / `spawnId` vocabulary because the current driver/event pipeline has not been fully renamed. Treat those names as storage details, not the primary public authoring API.

## Effect v4 package baseline

Mill targets the Effect v4 package line:

```json
{
  "dependencies": {
    "effect": "4.0.0-beta.59",
    "@effect/platform-bun": "4.0.0-beta.59"
  }
}
```

Patch versions may move together. New internal code must follow Effect v4 module names and API shapes.

## File layout

```text
src/
  index.ts                   # public package barrel / package entrypoint
  types.ts                   # user-facing interfaces allowed
  *.api.ts                   # Promise-based public adapters
  *.schema.ts                # Schema-based domain models
  *.effect.ts                # internal Effect programs/services/runtime helpers
  *.codec.ts                 # decode/encode modules
  test-runtime.ts            # test-only boundary helper
  mill.ts                    # CLI executable entrypoint (cli package)
```

## Invariants

1. Public examples use `mill.task({ agent: codex(...) })`.
2. Internal runtime code remains Effect-first.
3. Promise bridging happens only at approved boundaries.
4. CLI lifecycle commands remain stable.
5. Snapshots describe current state; events describe history.
6. `spawn-agent` stays internal to `@mill/driver-acp`.
