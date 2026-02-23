# mill v0 Product Spec (Sections 1–7)

_Source: `SPEC.md` (verbatim split for cedar-style docs tree)._

## 1) Product definition

`mill` is a runtime for executing TypeScript orchestration programs that spawn and coordinate AI agents.

A mill program is regular TS (sequential with `await`, parallel with `Promise.all`), with one injected global API:

- `mill.spawn(...)` (core)
- extension-contributed APIs (optional)

`mill` stores orchestration state and structured run events. Agent conversations remain owned by each agent tool; mill keeps `sessionRef` pointers.

## 2) Hard constraints

1. **Effect is the only execution system**
   - No `async/await` in core runtime modules.
   - No raw `Promise` construction.
   - No `try/catch` control flow (except inside Effect wrappers where required by external APIs).
2. **Process execution through Effect platform abstractions**
   - Drivers use Effect `Command` / process services.
   - On Bun, these are provided by `@effect/platform-bun` (Bun-backed runtime under the hood).
3. **Minimal CLI surface**
   - No `spec` or `template` subcommands in v0.
4. **Async-by-default runs**
   - `mill run <program.ts>` returns `runId` immediately unless `--sync` is passed.
5. **Drivers are generic infra adapters**
   - No vendor-specific driver concepts in core contracts.
   - Vendor specifics belong in codecs and config.
6. **Boundary clarity is mandatory**
   - `src/public/**` / `*.api.ts`: user-facing Promise + interface contracts.
   - `src/internal/**`, `src/domain/**`, `src/runtime/**`: Effect contracts + Schema domain models.
   - Internal interfaces are capability-only (method signatures), never domain shape definitions.
   - The boundary must be visible in filenames and enforced via ast-grep.
7. **Promise bridge is explicit and singular**
   - Only `Runtime.runPromise` is allowed as the Effect→Promise bridge.
   - It is allowed only at public boundary adapters (`src/public/**`, CLI entry adapters).
   - `Effect.runPromise*` and `Runtime.runPromiseExit` are disallowed.
8. **No shell-string command execution**
   - Drivers must construct commands as argument vectors (`Command.make(cmd, ...args)`).
   - Shell-eval patterns (`sh -lc`, `bash -lc`, interpolated command strings) are disallowed.
9. **Environment access is centralized**
   - `process.env` reads are allowed only in config/bootstrap loading modules.
   - Internal runtime logic receives resolved values via services/config objects.
10. **Time/random are injected**

- `Date.now()` and `Math.random()` are disallowed in runtime/domain internals.
- Use injected Effect services (`Clock`, `Random`) instead.

11. **Internal module boundaries are strict**

- Public modules must not import from `src/internal/**` directly.
- Package exports expose only public API entrypoints.

12. **Terminal state is single-shot**

- Each run/spawn emits exactly one terminal event (`complete` | `failed` | `cancelled`).
- Terminal states are immutable and idempotent.

## 3) CLI surface (v0)

```bash
mill run <program.ts> [--json] [--sync] [--driver <name>] [--executor <name>] [--confirm=false]
mill status <runId> [--json]
mill wait <runId> --timeout <seconds> [--json]
mill watch <runId> [--json] [--raw]
mill ls [--json] [--status <status>]
mill inspect <runId>[.<spawnId>] [--json] [--session]
mill cancel <runId> [--json]
mill init
```

Discovery (for humans and agents):

- `mill` (no subcommand): concise discovery card
- `mill --help`: help text + authoring guidance
- `mill --help --json`: machine-readable discovery payload

No other commands in v0.

### 3.1 Output mode contract

- `--json` mode:
  - `stdout` is machine-readable only (JSON for single response, JSONL for streams like `watch`).
  - human-friendly diagnostics/progress may be emitted on `stderr`.
- non-`--json` mode:
  - human output on `stdout` is expected.
- `--json` payloads may include `summaryHuman` fields for agent readability without breaking parsers.

## 4) Runtime topology

```text
mill program (TS)
  -> executor (direct | vm)
    -> engine (run lifecycle, API injection, events, persistence)
      -> driver (generic)
        -> agent process / remote endpoint

engine events -> watch/inspect/tui/automation
```

All layers are orthogonal:

- Executor = where program runs
- Driver = how spawns invoke agents
- Extension = hooks + extra API
- Observer = event consumer

## 5) Run model

### 5.1 Async default

`mill run` flow (default):

1. Resolve config
2. Validate program path
3. Optional interactive confirmation
4. Allocate `runId`, create run directory, write initial metadata
5. Start detached worker process
6. Return immediately (`runId`, `status=running`, paths)

`--sync` blocks until completion (implemented as submit + wait internally).

### 5.2 Run state machine

```text
pending -> running -> complete
                 -> failed
                 -> cancelled
```

### 5.3 Storage layout

```text
~/.mill/
  runs/
    <runId>/
      run.json                 # run metadata snapshot
      events.ndjson            # tier-1 structured events (append-only)
      result.json              # final summarized result
      program.ts               # copied execution input
      logs/
        worker.log
      spawns/
        <spawnId>.json         # optional derived spawn summary
```

## 6) Config contract (`mill.config.ts`)

```ts
import { defineConfig } from "@mill/core";

export default defineConfig({
  defaultDriver: "default",
  defaultModel: "openai/gpt-5.3-codex",
  defaultExecutor: "direct",

  drivers: {
    default: processDriver({
      command: "pi",
      args: ["-p"],
      codec: piCodec(),
      env: {},
    }),
  },

  executors: {
    direct: directExecutor(),
    vm: vmExecutor({ runtime: "docker", image: "mill-sandbox:latest" }),
  },

  authoring: {
    instructions:
      "Use systemPrompt for WHO and prompt for WHAT. Prefer cheaper models for search and stronger models for synthesis.",
  },

  extensions: [
    // optional
  ],
});
```

### 6.1 Config resolution order

1. `./mill.config.ts` (cwd)
2. walk upward to repo root
3. `~/.mill/config.ts`
4. internal defaults

### 6.2 Environment resolution policy

- Environment variables are read in config/bootstrap only.
- Resolved env values are normalized into config/services and passed downward.
- Runtime/domain modules must not read `process.env` directly.

## 7) Discovery contract (`mill --help --json`)

`mill --help --json` MUST include enough info for an agent to author a program without extra docs:

```json
{
  "discoveryVersion": 1,
  "programApi": {
    "spawnRequired": ["agent", "systemPrompt", "prompt"],
    "spawnOptional": ["model"],
    "resultFields": ["text", "sessionRef", "agent", "model", "driver", "exitCode", "stopReason"]
  },
  "drivers": {
    "default": {
      "description": "Local process driver",
      "modelFormat": "provider/model-id",
      "models": ["openai/gpt-5.3-codex", "anthropic/claude-sonnet-4-6"]
    }
  },
  "authoring": {
    "instructions": "...from config..."
  },
  "async": {
    "submit": "mill run <program.ts> --json",
    "status": "mill status <runId> --json",
    "wait": "mill wait <runId> --timeout 30 --json"
  }
}
```
