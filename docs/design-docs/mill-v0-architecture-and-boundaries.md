# mill v0 architecture and boundaries

## Shape

Mill is a config-free task actor runtime. Normal programs import from `@mill/core/program`:

```ts
import { codex, task } from "@mill/core/program";

const review = task({
  agent: codex("openai-codex/gpt-5.3-codex"),
  prompt: "Review src/auth.",
}).start();

await review.done;
```

The imported helpers are bound to the current run through `ProgramContext`. Core/CLI program authoring does not use an ambient global.

## Runtime topology

```text
CLI/API caller
  -> run API
    -> engine
      -> program host
        -> dynamic import under ProgramContext
          -> task actor
            -> agent runtime/session
```

The CLI is batteries-included for built-in `codex`, `claude`, and `pi` providers. Core keeps `spawn-agent` and ACP details out of the public API.

## Package boundaries

- `packages/core/src/*.api.ts` exposes public Promise/actor surfaces.
- `packages/core/src/*.effect.ts` contains Effect-native internals.
- `packages/core/src/*.schema.ts` contains persisted/domain schemas.
- `packages/cli/src/mill.ts` is the executable Effect platform entrypoint.
- `packages/cli/src/index.ts` maps CLI commands to core runtime calls.
- `packages/provider-acp` is an internal implementation package for built-in ACP-backed provider runtimes.
- `packages/

## Program host

The program host dynamically imports a TypeScript program under a current `ProgramContext`. Top-level await controls completion. The host may read `result` / `default` exports or infer a single task result, but a program can simply await its tasks.

The old generated global/protocol runtime is not part of the normal core/CLI path.

## Task actor boundary

A task actor owns lifecycle state, snapshots, queued steering commands, terminal result, and a session pointer when available. Snapshots are reduced current state; events are append-only history.

## Built-in provider boundary

Task input carries an `AgentProvider` descriptor:

```ts
{
  agent: codex("openai-codex/gpt-5.3-codex"),
  prompt: "..."
}
```

The runtime resolves the provider id to a registered agent runtime. The CLI registers built-in providers. API callers can provide runtimes programmatically where needed.

## Storage boundary

New persisted orchestration records use task vocabulary: `task:*`, `taskId`, and `tasks`. Run records are durable and are the source for status, wait, watch, cancel, and ls.

## Effect boundary

Internals are Effect-first. Promise surfaces are restricted to public API wrappers and actor `.done`. IO belongs at explicit platform/runtime edges, using Effect platform services where available.

## Invariants

1. Public examples import from `@mill/core/program`.
2. No normal core/CLI program authoring path depends on a global `mill`.
3. No config file is required for built-in providers.
4. The CLI remains the lifecycle surface for durable runs.
5. ACP and `spawn-agent` remain implementation details.
