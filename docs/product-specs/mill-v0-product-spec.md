# mill v0 Product Spec (Sections 1–7)

_Source: `SPEC.md`, updated to reflect current CLI behavior._

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
mill run <program.ts> [--json] [--sync] [--runs-dir <path>] [--driver <name>] [--executor <name>] [--meta-json <json>]
mill status <runId> [--json] [--runs-dir <path>] [--driver <name>]
mill wait <runId> --timeout <seconds> [--json] [--runs-dir <path>] [--driver <name>]
mill watch [--run <runId>] [--since-time <iso>] [--json] [--raw] [--runs-dir <path>] [--driver <name>]
mill ls [--json] [--status <status>] [--runs-dir <path>] [--driver <name>]
mill inspect <runId>[.<spawnId>] [--json] [--session] [--runs-dir <path>] [--driver <name>]
mill cancel <runId> [--json] [--runs-dir <path>] [--driver <name>]
mill init [--global]
```

Help + authoring guidance:

- `mill` / `mill --help`: root help text with authoring guidance
- `mill <command> --help`: command help text + authoring guidance
- If resolved config overrides `authoring.instructions`, help uses that text.
- Otherwise help falls back to static guidance (`systemPrompt` = WHO, `prompt` = WHAT).

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
      spawns/
        <spawnId>.json         # optional derived spawn summary
```

## 6) Config contract (`mill.config.ts`)

Minimal import-free config (works for both local and global config paths):

```ts
export default {
  // Optional overrides:
  // defaultDriver: "pi",
  // defaultExecutor: "direct",
  // defaultModel: "openai-codex/gpt-5.3-codex",
  authoring: {
    instructions:
      "Use systemPrompt for WHO (role/method), prompt for WHAT (explicit task + scope + validation).",
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
4. If config does not override authoring instructions, help falls back to static guidance:
   - `systemPrompt` = WHO the agent is
   - `prompt` = WHAT to do now

There is no dedicated `discovery` subcommand in CLI v0.
