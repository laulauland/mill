# Vertical Slices Plan (v0)

> Historical note (2026-02-25): this execution plan captures the implementation path. Some S1 discovery references (`mill --help --json`, `discovery` command) are historical and no longer match the current CLI surface.

This plan sequences integrated, testable slices from highest-leverage foundation to full v0 behavior.

Each slice intentionally spans:

- `@mill/core` (engine/domain/runtime)
- `@mill/cli` (user-facing commands)
- at least one driver package (`@mill/driver-pi`, then multi-driver where relevant)

---

## S1 — Discovery + Config Resolution + Driver Catalog

**Goal**
Ship a reliable authoring/discovery entrypoint so humans/agents can self-serve usage via `mill --help --json`.

**Package span**

- core: discovery payload builder + config resolution service
- cli: `mill`, `--help`, `--help --json` output adapters
- driver-pi: model catalog surfaced into discovery

**Acceptance criteria**

1. **Test intent:** unit (payload/config), integration (cli↔core), e2e (`mill --help --json`).
2. `mill --help --json` returns `discoveryVersion: 1` and required fields from SPEC §7 (`programApi`, `drivers`, `authoring`, `async`).
3. Config resolution order follows SPEC §6.1 (cwd, upward, `~/.mill/config.ts`, defaults) and is covered by tests.
4. `--json` mode writes machine payload to stdout only; human diagnostics stay on stderr.
5. Driver model list in discovery is sourced via driver codec catalog path, not hardcoded in CLI.

**Deliverables**

- `packages/core/src/public/discovery.api.ts` + config loader internals.
- `packages/cli/src/public/index.api.ts` command routing for discovery modes.
- `packages/driver-pi/src/public/index.api.ts` exposes catalog-backed registration.

**Test commands**

- `bun test packages/core/src/public/discovery.api.test.ts`
- `bun test packages/core/src/public/config-loader.api.test.ts`
- `bun test packages/cli/src/public/index.api.test.ts`
- `bun test packages/cli/src/public/index.e2e.test.ts`
- `bun test packages/driver-pi/src`

**Status (2026-02-23)**

- ✅ Implemented `resolveConfig` with SPEC §6.1 lookup order: cwd → upward (repo-root bounded) → `~/.mill/config.ts` → defaults.
- ✅ Hardened config resolution to skip upward lookup when no repo root is detected (prevents unrelated parent config capture outside repos).
- ✅ Implemented discovery payload builder with required SPEC §7 fields and `discoveryVersion: 1`.
- ✅ CLI routing now supports `mill`, `--help`, `--help --json` with JSON on stdout and human help on stdout in non-JSON mode (stderr reserved for diagnostics).
- ✅ Driver discovery models flow through driver codec catalog (`driver.codec.modelCatalog`) via `@mill/driver-pi` registration.
- ✅ Added unit/integration/e2e coverage for config resolution, discovery payload, CLI wiring, and `mill --help --json` command path.
- ✅ Extended config-loader tests + implementation to support computed `authoring.instructions` const-expression forms in `mill.config.ts` (not just inline string literals), while preserving SPEC §6.1 resolution order.
- ✅ Re-ran full workspace `bun test` after S1 hardening; suite remains green.

---

## S2 — Sync Run Vertical Path (`run --sync`) with Persisted Tier-1 Events

**Goal**
Enable one complete, deterministic execution path from CLI to engine to driver with persisted run artifacts.

**Package span**

- core: run/store/event schemas + engine `runSync/submit/status`
- cli: `run --sync`, `status`
- driver-pi: process driver + codec -> tier-1 event mapping

**Acceptance criteria**

1. **Test intent:** unit (schema/decode/store), integration (engine↔driver), e2e (`run --sync`).
2. `mill run <program.ts> --sync --json` executes a program with injected `mill.spawn` and returns structured result.
3. Run directory includes `run.json`, `events.ndjson` (append-only), and `result.json` per SPEC §5.3.
4. Persisted events decode through Schema discriminated union and include `schemaVersion`, `runId`, sequence, timestamp.
5. `spawn:complete` payload includes non-empty `sessionRef` (SPEC invariant #2).

**Deliverables**

- `packages/core/src/domain/*.schema.ts` for run/spawn/event unions.
- `packages/core/src/internal/run-store.effect.ts`, `engine.effect.ts` sync lifecycle.
- `packages/cli` command handlers for `run --sync` and `status` JSON/human output.
- `packages/driver-pi` codec + process-driver implementation using `Command.make(cmd, ...args)`.

**Test commands**

- `bun test packages/core/src/domain`
- `bun test packages/core/src/internal`
- `bun test packages/cli/src`
- `bun test packages/driver-pi/src`

**Status (2026-02-23)**

- ✅ Added Tier-1 event discriminated union schemas in `packages/core/src/domain/event.schema.ts` with persisted decode helpers (`Schema.parseJson` + `Schema.decodeUnknown*`).
- ✅ Expanded run/spawn schema contracts with typed decode utilities for persisted artifacts (`run.json`, `result.json`) and runtime validation of `SpawnResult` (`sessionRef` non-empty).
- ✅ Implemented `packages/core/src/internal/run-store.effect.ts` for run directory creation and append-only `events.ndjson` persistence.
- ✅ Implemented sync lifecycle orchestration in `packages/core/src/internal/engine.effect.ts` (run start/status, spawn mapping, run terminal persistence).
- ✅ Implemented `run --sync` and `status` CLI command handlers in `packages/cli/src/public/index.api.ts`, with JSON mode contract preserved on stdout.
- ✅ Implemented process-backed pi driver runtime in `packages/driver-pi` with codec decoding and command invocation via `Command.make(cmd, ...args)`.
- ✅ Added unit/integration/e2e coverage for schemas, run store, engine↔driver flow, CLI `run --sync`, CLI `status`, and persisted artifact verification.
- ✅ Re-ran targeted slice suites (`core/domain`, `core/internal`, `cli/src`, `driver-pi/src`) with green results.

---

## S3 — Wait Semantics + Terminal Single-Shot Invariants

**Goal**
Enforce lifecycle correctness guarantees before detached execution complexity is added.

**Package span**

- core: state machine guards + terminal-event idempotence/rejection + `wait`
- cli: `wait <runId> --timeout <seconds>`
- driver-pi: deterministic fixture stream to simulate duplicate/late terminal events

**Acceptance criteria**

1. **Test intent:** unit (transition guards), integration (wait over persisted/live events), e2e (`wait` timeout/terminal behavior).
2. `wait` resolves on first terminal event and never transitions terminal->non-terminal afterward.
3. Duplicate terminal emissions are deterministically ignored or rejected per documented policy.
4. Exactly one terminal event per run and per spawn is enforced in tests (SPEC §9.6 + invariant #6).
5. Timeout behavior is deterministic and surfaced as typed error/output contract.

**Deliverables**

- Core lifecycle transition guard module + engine wait implementation.
- CLI `wait` command with JSON/non-JSON output parity.
- Driver test fixtures for malformed or duplicate terminal event sequences.

**Test commands**

- `bun test packages/core/src/internal`
- `bun test packages/cli/src/public`
- `bun test packages/driver-pi/src`

**Status (2026-02-23)**

- ✅ Added core lifecycle transition guards in `packages/core/src/internal/lifecycle-guard.effect.ts` and unit coverage for terminal single-shot / terminal→non-terminal rejection paths.
- ✅ Hardened run status transitions in `RunStore` so terminal statuses are immutable (`complete|failed|cancelled` cannot transition further).
- ✅ Implemented `MillEngine.wait(runId, timeout)` with deterministic polling over persisted events plus typed timeout error (`WaitTimeoutError`).
- ✅ `wait` now validates persisted event streams with lifecycle guards and tracks terminal observation without allowing post-terminal transitions.
- ✅ Implemented deterministic terminal policy: duplicate terminal emissions are rejected via `LifecycleInvariantError` (not ignored).
- ✅ Added CLI `wait` command (`mill wait <runId> --timeout <seconds> [--json]`) with JSON/human output parity.
- ✅ Added typed JSON timeout contract for CLI (`{ ok: false, error: { _tag: "WaitTimeoutError", runId, timeoutSeconds, message } }`) and non-zero timeout exit code.
- ✅ Added driver-pi malformed fixture coverage for duplicate/invalid terminal output ordering in codec + runtime integration tests.
- ✅ Added integration/e2e coverage for persisted/live wait behavior and timeout behavior.
- ✅ Re-ran full workspace `bun test`; suite is green.

---

## S4 — Async Detached Run Lifecycle (Dedicated)

**Goal**
Implement async-by-default submission with private worker process semantics.

**Package span**

- core/runtime: worker orchestration, submit metadata, status updates
- cli: `run` (default async), `_worker` private command path, `status`
- driver-pi: exercised in worker-executed program spawns

**Acceptance criteria**

1. **Test intent:** integration-heavy + e2e process lifecycle (`run` submit -> `status`/`wait` completion).
2. `mill run <program.ts> --json` returns immediately with `runId` and running/pending state unless `--sync` is used.
3. Worker command follows private API contract (`mill _worker --run-id ...`) and performs idempotent finalize.
4. Program copy and worker log artifacts are written under run directory (`program.ts`, `logs/worker.log`).
5. `--sync` is implemented as submit + wait composition, sharing lifecycle logic.

**Deliverables**

- `packages/core/src/runtime/worker.effect.ts` detached worker runtime.
- CLI wiring for async submit path and private worker entrypoint.
- Driver-pi execution exercised by detached worker integration tests.

**Test commands**

- `bun test packages/core/src/runtime`
- `bun test packages/core/src/internal`
- `bun test packages/cli/src/bin`
- `bun test packages/driver-pi/src`

**Status (2026-02-25)**

- ✅ Implemented `runDetachedWorker` in `packages/core/src/runtime/worker.effect.ts` for detached execution lifecycle.
- ✅ CLI `run` command submits asynchronously by default and returns `runId` immediately with `pending`/`running` status.
- ✅ Private `_worker` command path exists with contract `mill _worker --run-id <id> --program <path> --runs-dir <dir>` and performs idempotent `finalizeTerminal`.
- ✅ Worker writes program copy (`program.ts`), program host artifacts (`program-host.ts`, `program-host.marker`), and worker log (`logs/worker.log`) to run directory.
- ✅ `--sync` mode implemented as `submitRun` + `waitForRun` composition with shared lifecycle logic.
- ✅ Detached worker stdio configured to `ignore` for non-blocking async submission.
- ✅ Added integration/e2e coverage for async submit -> status -> wait completion flow.
- ✅ Verified worker process detachment and run directory artifact persistence.
- ✅ Re-ran slice-specific tests; worker lifecycle passes.

---

## S5 — Driver/Executor Selection + Extension API Injection

**Goal**
Reach configurable runtime composition while preserving strict boundary contracts.

**Package span**

- core: driver/executor registries, extension hooks, runtime API injection bridge
- cli: `--driver`, `--executor`, `init` baseline scaffolding path
- drivers: pi + claude + codex package registration surfaces

**Acceptance criteria**

1. **Test intent:** unit (registry/bridge), integration (selected driver/executor path), e2e (`run --driver ... --executor ...`).
2. CLI resolves configured defaults and explicit `--driver/--executor` overrides correctly.
3. Extension `api` methods are injected onto `globalThis.mill` and bridge via `Runtime.runPromise` only at boundary adapters.
4. Extension hook failures emit structured error events without crashing the run by default.
5. Discovery/help metadata reflects registered drivers and authoring guidance from resolved config.

**Deliverables**

- Core registries + extension hook/event plumbing.
- CLI flag handling for driver/executor selection and `init` skeleton.
- Public adapters in `driver-claude` and `driver-codex` aligned to generic contracts (no vendor logic in core).

**Test commands**

- `bun test packages/core/src/public`
- `bun test packages/core/src/internal`
- `bun test packages/cli/src`
- `bun test packages/driver-pi/src packages/driver-claude/src packages/driver-codex/src`

**Status (2026-02-25)**

- ✅ Implemented driver and executor registries (`makeDriverRegistry`, `makeExecutorRegistry`) in core.
- ✅ CLI resolves configured defaults and honors explicit `--driver` and `--executor` overrides.
- ✅ Extension API methods are injected onto `globalThis.mill` via program host with proper `Runtime.runPromise` bridging.
- ✅ Extension hook failures emit `extension:error` events without crashing the run.
- ✅ Discovery payload includes registered driver models and authoring guidance from config.
- ✅ `mill init` command creates scaffold `mill.config.ts` with all three drivers and direct executor.
- ✅ Added unit/integration/e2e coverage for driver/executor selection and extension injection.
- ✅ Re-ran targeted verification tests for S5 functionality.

---

## S6 — Guardrail + ast-grep Boundary Enforcement (Dedicated)

**Goal**
Lock architecture constraints so future slices cannot regress Effect/boundary safety.

**Package span**

- core: boundary-compliant module names/contracts validated by rules
- cli: boundary adapter checks + no internal imports from public API
- driver packages: process safety and decode/env/time/random constraints validated across at least driver-pi

**Acceptance criteria**

1. **Test intent:** rule-level unit tests + integration tests that run guardrail scans from Bun test harness.
2. Required ast-grep rules from SPEC §19 exist and pass against positive/negative fixtures.
3. Boundary rules enforce: Promise/interface only in public boundary, no public->internal imports, bridge restrictions (`Runtime.runPromise` only at boundary).
4. Runtime safety rules enforce: no shell-string execution, no internal `process.env`/`Date.now`/`Math.random`, JSON parse only in codec/schema modules.
5. Export boundary check prevents internal path exports from any package.

**Deliverables**

- `.ast-grep/rules/*`, `.ast-grep/tests/*` expanded to full required set.
- Guardrail validation test harness invoked from Bun tests.
- `scripts/check-exports.ts` coverage across all workspace packages.

**Test commands**

- `bun test .ast-grep/tests`
- `bun test scripts`
- `bun test`

**Status (2026-02-23)**

- ✅ Expanded `.ast-grep/tests/` with rule-level positive/negative fixtures for the full SPEC §19 rule set.
- ✅ Hardened boundary and runtime-safety rule coverage (`no-public-import-internal`, `no-node-imports`, `no-shell-string-command`, Promise/`any` guards) to satisfy missing fixture cases.
- ✅ Added Bun-test guardrail integration harness (`scripts/guardrail-harness.ts` + `scripts/guardrail-harness.test.ts`) that executes repository guardrail checks and validates failing fixture scans for boundary/runtime violations.
- ✅ Refactored `scripts/check-exports.ts` into a testable workspace-wide checker (`collectWorkspacePackageJsonPaths`, `checkExportBoundaries`, `isInternalExportPath`, CLI `runCheck`).
- ✅ Added `scripts/check-exports.test.ts` coverage for workspace glob discovery and internal export-path detection across conditional/array `exports` forms.
- ✅ Re-ran `bun run lint:ast-grep:test`, `bun test scripts`, and full `bun test` with green results.
- ✅ Follow-up hardening pass: `no-public-import-internal` now catches re-export forms (`export ... from`), `no-process-env-outside-config` now catches destructured `process.env`, and export-boundary checks now reject internal/runtime/domain **export keys** in addition to export target values.

---

## S7 — Final Hardening: watch/cancel/list Semantics (Dedicated Final Slice)

**Goal**
Complete observer/control semantics for robust long-running orchestration operations.

**Package span**

- core: `watch` channels (`events` / `io` / `all`), `cancel`, `list`, interruption-safe cancellation
- cli: `watch`, `cancel`, `ls`
- pi-mill runtime: completion replay via `watch --channel events`

**Acceptance criteria**

1. **Test intent:** integration + e2e command matrix across watch/cancel/list with concurrent runs.
2. `watch --json` emits valid JSONL envelopes, with `kind: "event"` for tier-1 events and `kind: "io"` for tier-2 stream lines.
3. `watch --channel io` streams passthrough IO without persisting those lines to `events.ndjson`.
4. `cancel <runId>` is interruption-safe, idempotent, and no-op for already terminal runs; emits at most one `run:cancelled` terminal event.
5. `ls`/`status` remain consistent with terminal invariants and persisted snapshots after cancellations/completions.

**Deliverables**

- Core observer stream implementations for event and IO channels tied to event log + in-memory fanout.
- CLI command handlers for `watch`, `cancel`, and `ls` with strict JSON stdout contract.
- pi-mill completion decoding from `watch --channel events` output.

**Test commands**

- `bun test packages/core/src/internal`
- `bun test packages/core/src/runtime`
- `bun test packages/cli/src`
- `bun test`

**Status (2026-02-26)**

- ✅ Added core observer fanout hub (`packages/core/src/internal/observer-hub.effect.ts`) and wired engine tier-1/tier-2 publishing to persisted append + in-memory live subscribers.
- ✅ Extended `MillEngine` with `watch`, `watchIo`, `cancel`, and `list` semantics.
- ✅ Hardened append path synchronization against concurrent terminal transitions by rehydrating lifecycle guard state from persisted events before each append.
- ✅ Added CLI `watch` channel/source/spawn filters and removed the separate `inspect` command surface.
- ✅ Fixed async submit detachment stdio to `ignore` so `run --json` remains non-blocking even under captured stdout in e2e contexts.
- ✅ Added integration/e2e coverage for command matrix behavior across watch/cancel/ls, including concurrent run cancellation invariants.
