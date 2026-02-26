# mill — Effect-first orchestration runtime (v0 spec)

Status: **Draft for implementation**  
Scope: local CLI + SDK runtime, detached async runs, generic drivers, Effect-only core

---

## 1) Product definition

`mill` is a runtime for executing TypeScript orchestration programs that spawn and coordinate AI agents.

A mill program is regular TS (sequential with `await`, parallel with `Promise.all`), with one injected global API:

- `mill.spawn(...)` (core)
- extension-contributed APIs (optional)

`mill` stores orchestration state and structured run events. Agent conversations remain owned by each agent tool; mill keeps `sessionRef` pointers.

---

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

---

## 3) CLI surface (v0)

```bash
mill run <program.ts> [--json] [--sync] [--driver <name>] [--executor <name>] [--confirm=false]
mill status <runId> [--json]
mill wait <runId> --timeout <seconds> [--json]
mill watch [--run <runId>] [--channel events|io|all] [--source driver|program] [--spawn <spawnId>] [--json]
mill ls [--json] [--status <status>]
mill cancel <runId> [--json]
mill init [--global]
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

---

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
- Driver = how spawns invoke agents
- Extension = hooks + extra API
- Observer = event consumer

---

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

---

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
    instructions: "Use systemPrompt for WHO and prompt for WHAT. Prefer cheaper models for search and stronger models for synthesis.",
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

---

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

---

## 8) Boundary contracts: public Promise API, internal Effect core

Rule of thumb (strict):

- **User-exposed surface**: Promise-based API + interfaces are allowed.
- **Everything else**: Effect-first (`Effect`, `Stream`, `Layer`) + Schema-defined domain types.

Concretely:

- Public boundary (`src/public/**`, ambient `*.d.ts`):
  - can expose `Promise<T>`
  - can use `interface` for ergonomics
- Internal/domain/runtime (`src/internal/**`, `src/domain/**`, `src/runtime/**`):
  - no public Promise contracts
  - domain shapes must be defined by `@effect/schema/Schema`
  - no interface-based domain modelling

Effect contracts used internally:

- effects: `Effect.Effect<A, E, R>`
- streams: `Stream.Stream<A, E, R>`
- layers: `Layer.Layer<ROut, E, RIn>`
- queue/pubsub for event fanout
- schemas via `@effect/schema/Schema`

### 8.1 Domain schemas (representative)

```ts
import * as Schema from "@effect/schema/Schema";

export const RunId = Schema.String.pipe(Schema.brand("RunId"));
export type RunId = Schema.Schema.Type<typeof RunId>;

export const SpawnId = Schema.String.pipe(Schema.brand("SpawnId"));
export type SpawnId = Schema.Schema.Type<typeof SpawnId>;

export const RunStatus = Schema.Literal("pending", "running", "complete", "failed", "cancelled");
export type RunStatus = Schema.Schema.Type<typeof RunStatus>;

export const SpawnOptions = Schema.Struct({
  agent: Schema.NonEmptyString,
  systemPrompt: Schema.NonEmptyString,
  prompt: Schema.NonEmptyString,
  model: Schema.optional(Schema.NonEmptyString),
});

export type SpawnOptions = Schema.Schema.Type<typeof SpawnOptions>;

export const SpawnResult = Schema.Struct({
  text: Schema.String,
  sessionRef: Schema.NonEmptyString,
  agent: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  driver: Schema.NonEmptyString,
  exitCode: Schema.Number,
  stopReason: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
});

export type SpawnResult = Schema.Schema.Type<typeof SpawnResult>;
```

### 8.2 Error model

All errors are tagged Effect data errors.

```ts
class ConfigError extends Data.TaggedError("ConfigError")<{ message: string }> {}
class RunNotFoundError extends Data.TaggedError("RunNotFoundError")<{ runId: string }> {}
class DriverError extends Data.TaggedError("DriverError")<{ driver: string; message: string }> {}
class ProgramExecutionError extends Data.TaggedError("ProgramExecutionError")<{ runId: string; message: string }> {}
class PersistenceError extends Data.TaggedError("PersistenceError")<{ path: string; message: string }> {}
```

### 8.3 Core services

Service contracts may use `interface`, but only for **capabilities** (methods), not domain data modelling. Their methods remain Effect-typed.

```ts
interface RunStore {
  create(meta: RunMeta): Effect.Effect<void, PersistenceError>;
  appendEvent(runId: RunId, event: MillEvent): Effect.Effect<void, PersistenceError>;
  setStatus(runId: RunId, status: RunStatus): Effect.Effect<void, PersistenceError>;
  setResult(runId: RunId, result: RunResult): Effect.Effect<void, PersistenceError>;
  getRun(runId: RunId): Effect.Effect<RunRecord, RunNotFoundError | PersistenceError>;
  listRuns(filter?: RunFilter): Effect.Effect<ReadonlyArray<RunRecord>, PersistenceError>;
}

interface Driver {
  readonly name: string;
  readonly spawn: (
    input: DriverSpawnInput,
  ) => Effect.Effect<DriverSpawnHandle, DriverError, Scope.Scope>;
}

interface DriverSpawnHandle {
  readonly events: Stream.Stream<DriverEvent, DriverError>;
  readonly raw: Stream.Stream<Uint8Array, never>;
  readonly result: Effect.Effect<SpawnResult, DriverError>;
  readonly cancel: Effect.Effect<void, never>;
}

interface Executor {
  readonly name: string;
  readonly runProgram: (
    input: ProgramRunInput,
  ) => Effect.Effect<ProgramRunHandle, ProgramExecutionError, Scope.Scope>;
}

interface ProgramRunHandle {
  readonly events: Stream.Stream<MillEvent, ProgramExecutionError>;
  readonly result: Effect.Effect<RunResult, ProgramExecutionError>;
  readonly cancel: Effect.Effect<void, never>;
}
```

### 8.4 Engine service

```ts
interface MillEngine {
  submit(input: SubmitRunInput): Effect.Effect<SubmitRunOutput, ConfigError | PersistenceError | ProgramExecutionError>;
  runSync(input: SubmitRunInput): Effect.Effect<RunResult, ConfigError | PersistenceError | ProgramExecutionError>;
  status(runId: RunId): Effect.Effect<RunRecord, RunNotFoundError | PersistenceError>;
  wait(runId: RunId, timeout: Duration.DurationInput): Effect.Effect<RunRecord, RunNotFoundError | PersistenceError>;
  watch(runId: RunId): Stream.Stream<MillEvent, RunNotFoundError | PersistenceError>;
  cancel(runId: RunId): Effect.Effect<void, RunNotFoundError | PersistenceError>;
  inspect(ref: RunOrSpawnRef): Effect.Effect<InspectResult, RunNotFoundError | PersistenceError>;
}
```

### 8.5 Effect runtime primitives used in mill

`mill` implementation uses these Effect modules as first-class building blocks:

- `Effect.gen`, `Effect.scoped`, `Effect.acquireRelease`, `Effect.timeout`, `Effect.retry`, `Effect.interrupt`
- `Fiber` / `FiberSet` for supervised detached run workers
- `Queue` for per-run ordered event buffering
- `PubSub` for fanout to multiple live watchers
- `Stream` for driver output decoding and watch subscriptions
- `Ref` / `SynchronizedRef` for in-memory run registry snapshots
- `Layer` + `Context.Tag` for all services (`RunStore`, `DriverRegistry`, `ExecutorRegistry`, `Clock`, etc.)
- `Runtime` for bridging program-facing Promise API (`mill.spawn(): Promise<...>`) to internal Effects via **only** `Runtime.runPromise`

Target platform services:

- `@effect/platform/Command`
- `@effect/platform/FileSystem`
- `@effect/platform/Path`
- `@effect/platform/Terminal`
- `@effect/platform-bun` runtime layer for Bun-backed implementations

### 8.6 Package baseline (Effect v4 target)

`mill` pins to Effect v4-compatible package line:

```json
{
  "dependencies": {
    "effect": "^4.x",
    "@effect/platform": "^1.x",
    "@effect/platform-bun": "^1.x",
    "@effect/schema": "^1.x"
  }
}
```

(Exact minor versions are implementation-time decisions; API usage must stay within documented stable modules.)

### 8.7 File layout + naming (boundary is visible in filenames)

```text
src/
  public/
    mill.api.ts              # Promise-based user API
    discovery.api.ts         # Promise-based CLI/discovery payload builders
    types.ts                 # user-facing interfaces allowed
  domain/
    run.schema.ts            # Schema-based domain models (no interfaces)
    spawn.schema.ts
  internal/
    engine.effect.ts         # internal Effect programs/services
    run-store.effect.ts
    driver.effect.ts
  runtime/
    worker.effect.ts
```

Naming rules:

- `*.api.ts` => user boundary (Promise + interfaces allowed)
- `*.schema.ts` => domain data contracts (`Schema` + `Schema.Type` exports)
- `*.effect.ts` => internal runtime/effectful orchestration code

If a file defines domain entities and is not `*.schema.ts`, it is considered a spec violation.

### 8.8 Quick classification examples

Allowed (public boundary):

```ts
// src/public/mill.api.ts
export interface Mill {
  spawn(input: SpawnInput): Promise<SpawnOutput>;
}
```

Required (internal):

```ts
// src/internal/engine.effect.ts
export const submit = (
  input: SubmitRunInput,
): Effect.Effect<SubmitRunOutput, SubmitError, RunStore | DriverRegistry> =>
  Effect.gen(function* () {
    // ...
  });
```

Required (domain):

```ts
// src/domain/run.schema.ts
export const RunRecord = Schema.Struct({
  id: RunId,
  status: RunStatus,
  startedAt: Schema.String,
});
export type RunRecord = Schema.Schema.Type<typeof RunRecord>;
```

Disallowed:

```ts
// src/domain/run.ts
export interface RunRecord { // lint error
  id: string;
  status: string;
}
```

### 8.9 Promise bridge and decode boundaries

- Allowed bridge:
  - `Runtime.runPromise` only
- Disallowed bridges:
  - `Effect.runPromise`
  - `Effect.runPromiseExit`
  - `Runtime.runPromiseExit`
- Bridge location:
  - boundary adapters only (`src/public/**`, CLI boundary entrypoints)

Decode policy:

- `JSON.parse` is only allowed in codec/schema decoding modules (`*.codec.ts`, `*.schema.ts`).
- Parsed values must be validated with `Schema.decodeUnknown*` before use.
- Ad-hoc parsing in engine/runtime/business modules is disallowed.

---

## 9) Event model

Two tiers:

### Tier 1 (structured, persisted)

Required core events:

- `run:start`
- `run:status`
- `run:complete`
- `run:failed`
- `run:cancelled`
- `spawn:start`
- `spawn:milestone`
- `spawn:tool_call`
- `spawn:error`
- `spawn:complete`
- `spawn:cancelled`

All tier-1 events must include:

- `schemaVersion` (integer, starts at `1`)
- `runId`
- event `type` (discriminant)
- monotonic sequence number
- timestamp

Encoding/decoding requirements:

- persisted event payloads are defined as a Schema discriminated union
- writers encode from typed values
- readers decode with `Schema.decodeUnknown*`
- unknown schema versions are surfaced as typed decode errors

Tier 1 is written to `events.ndjson` and is the source for `watch` (events channel), `status`/`wait` terminal checks, and extensions.

### Tier 1 lifecycle invariants

Exactly one terminal event is allowed per run and per spawn:

- run terminal set: `run:complete | run:failed | run:cancelled`
- spawn terminal set: `spawn:complete | spawn:error | spawn:cancelled`

Transition table:

```text
run:   pending -> running -> complete|failed|cancelled
spawn: pending -> running -> complete|error|cancelled
```

Terminal states have no outgoing transitions.
`mill wait` resolves on first observed terminal event and treats additional terminal events as invariant violations.

### Tier 2 (io passthrough, ephemeral)

- line-oriented IO from driver/program streams
- available live via `watch --channel io` (or merged via `watch --channel all`)
- not persisted by engine

---

## 10) Driver architecture

## 10.1 Generic driver + codec split

Core does not encode vendor semantics.

- `processDriver(...)` and `httpDriver(...)` are generic factories.
- `codec` parses native output into `DriverEvent` + `SpawnResult`.

```ts
interface DriverCodec {
  readonly decodeEvent: (chunk: Uint8Array) => Effect.Effect<ReadonlyArray<DriverEvent>, CodecError>;
  readonly decodeFinal: (aggregate: ReadonlyArray<Uint8Array>) => Effect.Effect<SpawnResult, CodecError>;
  readonly modelCatalog: Effect.Effect<ReadonlyArray<string>, never>;
}
```

## 10.2 Process driver execution (Bun-backed via Effect)

Driver process spawning MUST be implemented with Effect platform command APIs and Bun context layer.

Implementation pattern:

1. Build command (`Command.make(command, ...args)`)
2. Apply env/cwd/stdin
3. Start process via platform `Command` executor
4. Consume stdout/stderr as `Stream`
5. Parse via codec to structured events
6. Await exit code and final decode

Command safety requirements:

- commands must be built as arg vectors (`Command.make(cmd, ...args)`)
- `sh -lc`, `bash -lc`, and interpolated shell command strings are disallowed
- untrusted/user-provided values must flow as args, never shell source text

The implementation layer includes `@effect/platform-bun` runtime context so process operations are backed by Bun spawn internally while preserving typed Effect semantics.

---

## 11) Executor architecture

### 11.1 Direct executor (default)

- executes the TS program using Bun in local environment
- injects `globalThis.mill`
- enforces scoped lifecycle and cancellation

### 11.2 VM executor (optional)

- same engine contracts
- runs program in sandboxed runtime (docker/firecracker/gvisor)

Executor has no driver knowledge.

---

## 12) Program API injected into runtime

This is a **user-facing boundary**, so Promise-returning signatures are intentional.

```ts
declare global {
  const mill: {
    spawn(opts: SpawnOptions): Promise<SpawnResult>;
    // extension APIs merged in at runtime
    [key: string]: unknown;
  };
}
```

Runtime validation:

- `systemPrompt` must be non-empty
- `prompt` must be non-empty
- `agent` must be non-empty

Behavior:

- each `spawn` allocates `spawnId`
- engine emits `spawn:start`
- driver handle streams events
- engine maps to tier-1 events and persists
- resolve final `SpawnResult`

---

## 13) Background worker process

Internal worker command (private API):

```bash
mill _worker --run-id <id> --program <abs-path> --config <resolved-config> [--driver ...] [--executor ...]
```

Worker responsibilities:

1. mark run `running`
2. execute program through engine
3. append tier-1 events
4. write final `result.json`
5. mark terminal status exactly once (idempotent finalize)

CLI `run` command only submits and detaches worker (unless `--sync`).

---

## 14) Extensions

```ts
interface Extension {
  readonly name: string;
  readonly setup?: (ctx: ExtensionContext) => Effect.Effect<void, ExtensionError, Scope.Scope>;
  readonly onEvent?: (event: MillEvent, ctx: ExtensionContext) => Effect.Effect<void, ExtensionError>;
  readonly api?: Record<string, (...args: ReadonlyArray<unknown>) => Promise<unknown>>;
}
```

Rules:

- Extension failure does not crash engine by default; failure becomes `extension:error` event.
- `api` contributions are namespaced into injected `mill` object.
- Extension hooks (`setup`, `onEvent`) stay Effect-native.
- Extension `api` is user-facing, therefore Promise-based by contract.
- Promise adapters for extension API must use `Runtime.runPromise` as the only bridge.

---

## 15) Observers

Observers consume tier-1 stream (and optionally tier-2 live io stream):

- `mill watch --channel events`
- `mill watch --channel io|all`
- future TUI/web UI
- automation reading NDJSON

Observers are read-only; they do not mutate engine state.

---

## 16) Session ownership + pointers

Spawn `sessionRef` values are emitted in `spawn:complete` events and summarized in `result.json`.

Engine never normalizes full transcript ownership.

---

## 17) Cancellation semantics

`mill cancel <runId>`:

1. mark run as cancelling
2. interrupt worker fiber
3. propagate cancel to all live spawn handles (`handle.cancel`)
4. append `run:cancelled` (only if run is not already terminal)
5. mark terminal state `cancelled`

Cancellation must be interruption-safe and idempotent.
If run is already terminal, cancellation is a no-op.

---

## 18) SDK contract (`@mill/core`)

```ts
interface CreateEngineInput {
  readonly config: MillConfig;
}

declare const createEngine: (
  input: CreateEngineInput,
) => Effect.Effect<MillEngine, ConfigError, Scope.Scope>;
```

CLI is a thin wrapper around SDK service methods.

### 18.1 Package export boundary

`package.json` exports must expose only public entrypoints (`src/public/**` build outputs).

- consumers must not import `src/internal/**` / `src/runtime/**` directly
- internal modules are considered private implementation detail
- CI should fail if an internal path is exported

---

## 19) Constraint toolchain (cedar-style)

This is mandatory for mill repo setup.

### 19.1 Tooling

- `ast-grep` (structural guardrails)
- `oxlint` (fast lint)
- `oxfmt` (format)
- `tsgo` (`@typescript/native-preview`) for typecheck
- `bun test` for tests

### 19.2 Required files

```text
.ast-grep/
  sgconfig.yml
  rules/
    no-any.yml
    no-as-unknown-as.yml
    no-bun-globals.yml
    no-date-now-outside-clock.yml
    no-dot-then.yml
    no-dynamic-import.yml
    no-effect-runpromise.yml
    no-interface-for-domain-models.yml
    no-interface-outside-public.yml
    no-json-parse-outside-codec.yml
    no-math-random-outside-random.yml
    no-node-imports.yml
    no-process-env-outside-config.yml
    no-promise-outside-public.yml
    no-public-import-internal.yml
    no-raw-promise.yml
    no-runtime-runpromise-outside-boundary.yml
    no-shell-string-command.yml
    no-stub-functions.yml
    no-throw.yml
    no-try-catch.yml
  tests/
    *.test.yml
.oxlintrc.json
.oxfmtrc.json
scripts/
  check-exports.ts
```

`sgconfig.yml` pattern (cedar-style):

```yml
ruleDirs:
  - .ast-grep/rules
```

### 19.3 Required scripts

```json
{
  "scripts": {
    "test": "bun test",
    "typecheck": "tsgo --noEmit",
    "lint": "oxlint .",
    "lint:fix": "oxlint . --fix",
    "lint:ast-grep:test": "ast-grep test --config .ast-grep/sgconfig.yml --skip-snapshot-tests",
    "lint:ast-grep": "ast-grep scan --config .ast-grep/sgconfig.yml src --error",
    "lint:effect": "ast-grep scan --config .ast-grep/sgconfig.yml src/internal src/domain src/runtime --error --filter 'no-(raw-promise|try-catch|throw|dot-then|any|bun-globals|node-imports|dynamic-import)'",
    "lint:boundary": "ast-grep scan --config .ast-grep/sgconfig.yml src --error --filter 'no-(interface-outside-public|promise-outside-public|interface-for-domain-models|effect-runpromise|runtime-runpromise-outside-boundary|public-import-internal)'",
    "lint:runtime-safety": "ast-grep scan --config .ast-grep/sgconfig.yml src/internal src/domain src/runtime --error --filter 'no-(json-parse-outside-codec|shell-string-command|process-env-outside-config|date-now-outside-clock|math-random-outside-random)'",
    "lint:exports": "bun run scripts/check-exports.ts",
    "format": "oxfmt . --write",
    "format:check": "oxfmt . --check",
    "check": "bun run lint:ast-grep:test && bun run lint:effect && bun run lint:boundary && bun run lint:runtime-safety && bun run lint:exports && bun run lint:ast-grep && bun run lint && bun run format:check && bun run typecheck && bun test"
  }
}
```

### 19.4 Baseline lint/format config

`.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "env": { "builtin": true },
  "categories": { "correctness": "error" },
  "ignorePatterns": ["node_modules", ".jj", "dist"]
}
```

`.oxfmtrc.json`:

```json
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "ignorePatterns": ["node_modules", ".jj", "dist", "SPEC.md"]
}
```

### 19.5 Guardrail intent

- ban direct Bun globals (`Bun.spawn`, `Bun.file`, etc.) in core runtime
- ban direct `node:` imports in app modules
- ban untyped throw/catch/promise patterns
- enforce Effect-centric architecture and composability
- enforce boundary policy:
  - `no-interface-for-domain-models`: domain entities must come from `Schema`
  - `no-interface-outside-public`: interfaces are allowed only in `src/public/**` and `*.d.ts` (plus explicit allowlist files like config declarations)
  - `no-promise-outside-public`: Promise-returning contracts are allowed only at user boundary files (`*.api.ts`, `src/public/**`)
  - `no-effect-runpromise`: ban `Effect.runPromise*` usage entirely
  - `no-runtime-runpromise-outside-boundary`: only `Runtime.runPromise` may bridge, and only in boundary adapters
  - `no-public-import-internal`: public API modules cannot import private internals directly
- enforce parsing/process/runtime safety:
  - `no-json-parse-outside-codec`: restrict `JSON.parse` to decode modules and require Schema decode
  - `no-shell-string-command`: disallow shell-eval process invocation patterns
  - `no-process-env-outside-config`: restrict env reads to config/bootstrap
  - `no-date-now-outside-clock`: force injected clock usage
  - `no-math-random-outside-random`: force injected random service usage

Practical exception policy:

- internal service capability interfaces (method-only, Effect return types) are allowed in `*.service.ts` / `*.effect.ts` through explicit ast-grep rule allow patterns
- any interface with data fields in `src/domain/**`, `src/internal/**`, `src/runtime/**` is a lint error
- codec/schema files are allowlisted for parsing operations; all downstream modules consume decoded typed values

### 19.6 Required contract tests

- `--json` mode contract tests:
  - stdout contains valid JSON/JSONL only
  - human-readable diagnostics are emitted to stderr only
- lifecycle contract tests:
  - exactly one terminal event per run
  - exactly one terminal event per spawn
  - no terminal -> non-terminal transitions
  - duplicate terminal emissions are ignored or rejected deterministically

---

## 20) Invariants

1. Every run has append-only tier-1 event log.
2. Every spawn completion includes `sessionRef`.
3. Engine persists orchestration state only (not full transcript).
4. Public user APIs are Promise-based façades; internal APIs remain Effect-typed.
5. `--json` mode writes machine payloads to `stdout` only; human diagnostics go to `stderr`.
6. Each run/spawn emits exactly one terminal event and never transitions afterward.
7. All persisted tier-1 events include `schemaVersion` and decode via Schema unions.
8. `Runtime.runPromise` is the only permitted Effect→Promise bridge.
9. Runtime/domain internals do not read `process.env`, `Date.now()`, or `Math.random()` directly.
10. `mill run` returns immediately by default.

---

## 21) v0 non-goals

- hosted control plane / multi-tenant server
- built-in template subcommands
- advanced workflow DSLs beyond plain TS
- driver hot-swapping policies inside program logic

---

## 22) Implementation order

1. Core domain schemas + error model
2. RunStore + event append persistence
3. Generic process driver + one codec (pi or claude)
4. Engine submit/status/wait/watch/cancel
5. Worker process + detached `run`
6. `watch` channel finalization + cancellation bridge
7. Extension hooks
8. Guardrail toolchain + rules/tests

---

## 23) Canonical program example

```ts
const scan = await mill.spawn({
  agent: "scout",
  systemPrompt: "You are a code risk analyst. Prioritize highest-impact findings.",
  prompt: "Review src/auth and summarize top security and reliability risks.",
  model: "openai/gpt-5.3-codex",
});

const synth = await mill.spawn({
  agent: "synth",
  systemPrompt: "You turn findings into an execution-ready plan.",
  prompt: `Create a step-by-step remediation plan from this analysis:\n\n${scan.text}`,
});

console.log(synth.text);
```

This remains plain TypeScript orchestration with `await` / `Promise.all` and no DSL.
