# mill v0 Architecture & Boundaries (Sections 8–18)

_Source: `SPEC.md` (verbatim split for cedar-style docs tree)._

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
class ProgramExecutionError extends Data.TaggedError("ProgramExecutionError")<{
  runId: string;
  message: string;
}> {}
class PersistenceError extends Data.TaggedError("PersistenceError")<{
  path: string;
  message: string;
}> {}
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
  submit(
    input: SubmitRunInput,
  ): Effect.Effect<SubmitRunOutput, ConfigError | PersistenceError | ProgramExecutionError>;
  runSync(
    input: SubmitRunInput,
  ): Effect.Effect<RunResult, ConfigError | PersistenceError | ProgramExecutionError>;
  status(runId: RunId): Effect.Effect<RunRecord, RunNotFoundError | PersistenceError>;
  wait(
    runId: RunId,
    timeout: Duration.DurationInput,
  ): Effect.Effect<RunRecord, RunNotFoundError | PersistenceError>;
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
    discovery.api.ts         # Promise-based core discovery payload builders
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
export interface RunRecord {
  // lint error
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

Tier 1 is written to `events.ndjson` and is the source for `watch`, `inspect`, and extensions.

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

### Tier 2 (raw passthrough, ephemeral)

- full raw bytes/text from driver process or remote stream
- available live via `watch --raw`
- not persisted by engine

## 10) Driver architecture

### 10.1 Generic driver + codec split

Core does not encode vendor semantics.

- `processDriver(...)` and `httpDriver(...)` are generic factories.
- `codec` parses native output into `DriverEvent` + `SpawnResult`.

```ts
interface DriverCodec {
  readonly decodeEvent: (
    chunk: Uint8Array,
  ) => Effect.Effect<ReadonlyArray<DriverEvent>, CodecError>;
  readonly decodeFinal: (
    aggregate: ReadonlyArray<Uint8Array>,
  ) => Effect.Effect<SpawnResult, CodecError>;
  readonly modelCatalog: Effect.Effect<ReadonlyArray<string>, never>;
}
```

### 10.2 Process driver execution (Bun-backed via Effect)

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

## 11) Executor architecture

### 11.1 Direct executor (default)

- executes the TS program using Bun in local environment
- injects `globalThis.mill`
- enforces scoped lifecycle and cancellation

### 11.2 VM executor (optional)

- same engine contracts
- runs program in sandboxed runtime (docker/firecracker/gvisor)

Executor has no driver knowledge.

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

## 14) Extensions

```ts
interface Extension {
  readonly name: string;
  readonly setup?: (ctx: ExtensionContext) => Effect.Effect<void, ExtensionError, Scope.Scope>;
  readonly onEvent?: (
    event: MillEvent,
    ctx: ExtensionContext,
  ) => Effect.Effect<void, ExtensionError>;
  readonly api?: Record<string, (...args: ReadonlyArray<unknown>) => Promise<unknown>>;
}
```

Rules:

- Extension failure does not crash engine by default; failure becomes `extension:error` event.
- `api` contributions are namespaced into injected `mill` object.
- Extension hooks (`setup`, `onEvent`) stay Effect-native.
- Extension `api` is user-facing, therefore Promise-based by contract.
- Promise adapters for extension API must use `Runtime.runPromise` as the only bridge.

## 15) Observers

Observers consume tier-1 stream (and optionally tier-2 live raw stream):

- `mill watch`
- `mill inspect`
- future TUI/web UI
- automation reading NDJSON

Observers are read-only; they do not mutate engine state.

## 16) `inspect --session`

`mill inspect <runId>.<spawnId> --session` resolves the spawn `sessionRef` via the originating driver and opens or prints a pointer to full native session history.

Engine never normalizes full transcript ownership.

## 17) Cancellation semantics

`mill cancel <runId>`:

1. mark run as cancelling
2. interrupt worker fiber
3. propagate cancel to all live spawn handles (`handle.cancel`)
4. append `run:cancelled` (only if run is not already terminal)
5. mark terminal state `cancelled`

Cancellation must be interruption-safe and idempotent.
If run is already terminal, cancellation is a no-op.

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
