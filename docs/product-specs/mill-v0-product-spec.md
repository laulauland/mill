# mill v0 Product Spec (Sections 1–7)

_Source: `SPEC.md`, updated to reflect current CLI behavior._

## 1) Product definition

`mill` is a runtime for executing TypeScript orchestration programs that create and coordinate AI agent task actors.

A mill program is regular TS (sequential with `await`, parallel with `Promise.all`) that imports the program API from `@mill/core/program`:

- `mill.task(...)` / `task(...)` for creating a task actor
- extension-contributed APIs on the imported `mill` context (optional)

A task actor is started with `.start()`, exposes current state through snapshots, and resolves its final result through `.done`.

```ts
import { codex, mill } from "@mill/core/program";

const task = mill
  .task({
    agent: codex("openai-codex/gpt-5.3-codex"),
    system: "You inspect code.",
    prompt: "Review src/auth.",
  })
  .start();

await task.done;
```

`mill` stores orchestration state and structured run events. Agent conversations remain owned by each agent tool; mill keeps `sessionRef` pointers.

## 2) Hard constraints

1. **Effect v4 / effect-smol is the internal execution baseline**
   - No `async/await` in core runtime modules.
   - No raw `Promise` construction outside public boundaries.
   - No `try/catch` control flow except inside Effect wrappers required by external APIs.
2. **Process execution through Effect platform abstractions**
   - Drivers use Effect platform command/process services.
   - On Bun, these are provided by `@effect/platform-bun`.
3. **Minimal CLI surface**
   - No `spec` or `template` subcommands in v0.
4. **Async-by-default runs**
   - `mill run <program.ts>` returns `runId` immediately unless `--sync` is passed.
5. **Drivers are generic infra adapters**
   - No vendor-specific driver concepts in core contracts.
   - Vendor specifics belong in drivers and config.
6. **Boundary clarity is mandatory**
   - `*.api.ts` plus flat public entry files (`src/index.ts`, `src/types.ts`, `src/test-runtime.ts`, CLI `src/mill.ts`): user-facing Promise + interface contracts.
   - `*.effect.ts`, `*.schema.ts`, `*.codec.ts`: internal Effect contracts + Schema/codec implementation modules.
7. **Promise bridge is explicit and singular**
   - Only `Effect.runPromise` is allowed as the Effect→Promise bridge.
   - It is allowed only at public boundary adapters (`*.api.ts`, approved flat entry files, CLI entry adapters).
8. **No shell-string command execution**
   - Drivers construct commands as argument vectors, never shell-eval strings.
9. **Environment access is centralized**
   - `process.env` reads are allowed only in config/bootstrap loading modules.
10. **Time/random are injected**

- Runtime/domain internals use injected Effect services rather than ambient time/random.

11. **Internal module boundaries are strict**

- Public modules must not import private implementation files directly.

12. **Terminal state is single-shot**

- Each run/task emits exactly one terminal outcome (`complete` | `failed` | `cancelled`).

## 3) CLI surface (v0)

```bash
mill run <program.ts> [--json] [--sync] [--runs-dir <path>] [--driver <name>] [--executor <name>] [--meta-json <json>]
mill status <runId> [--json] [--runs-dir <path>] [--driver <name>]
mill wait <runId> --timeout <seconds> [--json] [--runs-dir <path>] [--driver <name>]
mill watch [--run <runId>] [--since-time <iso>] [--channel events|io|all] [--source driver|program] [--task <taskId>] [--json] [--runs-dir <path>] [--driver <name>]
mill ls [--json] [--status <status>] [--runs-dir <path>] [--driver <name>]
mill cancel <runId> [--json] [--runs-dir <path>] [--driver <name>]
mill init [--global]
```

Help + authoring guidance:

- `mill` / `mill --help`: root help text with authoring guidance.
- `mill <command> --help`: command help text + authoring guidance.
- If resolved config overrides `authoring.instructions`, help uses that text.
- Otherwise help falls back to static task guidance: choose an `agent` provider, use `system` for behavior, and use `prompt` for the work.

No `discovery` subcommand in v0.

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

engine events -> watch/tui/automation
```

All layers are orthogonal:

- Executor = where program runs
- Driver = how task actors invoke agents
- Extension = hooks + extra API
- Observer = event consumer

## 5) Run model

### 5.1 Async default

`mill run` flow (default):

1. Resolve config
2. Validate program path
3. Allocate `runId`, create run directory, write initial metadata
4. Start detached worker process
5. Return immediately (`runId`, `status=running`, paths)

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
      tasks/
        <taskId>.json          # optional derived task summaries
```

New persisted orchestration events and run results use task vocabulary (`task:*`, `taskId`, `tasks`). Driver internals may still use older adapter names until the session-first cleanup.

## 6) Config contract (`mill.config.ts`)

Minimal import-free config (works for both local and global config paths):

```ts
export default {
  // Optional overrides:
  // defaultDriver: "pi",
  // defaultExecutor: "direct",
  authoring: {
    instructions:
      "Create mill.task actors with agent providers. Use system for behavior and prompt for explicit scope + validation.",
  },
};
```

`mill init` writes `./mill.config.ts`.
`mill init --global` writes `~/.mill/config.ts`.

### 6.1 Config resolution order

1. `./mill.config.ts` (cwd)
2. walk upward to repo root
3. `~/.mill/config.ts`
4. internal defaults

### 6.2 Environment resolution policy

- Environment variables are read in config/bootstrap only.
- Resolved env values are normalized into config/services and passed downward.
- Runtime/domain modules must not read `process.env` directly.

## 7) Authoring help contract

`mill` help output is the primary authoring guide for humans/agents.

Behavior:

1. `mill` and `mill --help` print root help + authoring guidance.
2. `mill <command> --help` prints command help + authoring guidance.
3. If resolved config provides a custom `authoring.instructions` override, that text replaces static guidance in help output.
4. If config does not override authoring instructions, help falls back to static task actor guidance:
   - `agent` = provider factory such as `codex(model)`, `claude(model)`, or `pi(model)`
   - `system` = behavior/persona/method
   - `prompt` = concrete work to do now

There is no dedicated `discovery` subcommand in CLI v0.
