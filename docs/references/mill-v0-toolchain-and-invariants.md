# mill v0 Toolchain, Invariants, Non-goals, and Order

_Source: `SPEC.md`, toolchain/reference split._

## 19) Constraint toolchain (cedar-style)

This is mandatory for mill repo setup.

### 19.1 Tooling

- `ast-grep` (structural guardrails)
- `oxlint` (fast lint)
- `oxfmt` (format)
- `tsgo` (`@typescript/native-preview`) for typecheck
- `bun test` for tests
- Effect v4 / effect-smol package line for runtime internals

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

### 19.3 Required scripts

```json
{
  "scripts": {
    "test": "bun test",
    "typecheck": "tsgo --noEmit",
    "lint": "oxlint .",
    "lint:fix": "oxlint . --fix",
    "lint:ast-grep:test": "ast-grep test --config .ast-grep/sgconfig.yml --skip-snapshot-tests",
    "lint:ast-grep": "bun run lint:effect && bun run lint:boundary && bun run lint:runtime-safety",
    "lint:exports": "bun run scripts/check-exports.ts",
    "format": "oxfmt . --write",
    "format:check": "oxfmt . --check",
    "check": "bun run lint:ast-grep:test && bun run lint:exports && bun run lint:ast-grep && bun run lint && bun run format:check && bun run typecheck && bun test"
  }
}
```

### 19.4 Guardrail intent

- ban direct Bun globals in core runtime
- ban direct `node:` imports in app modules unless explicitly allowlisted at public/CLI boundaries
- ban untyped throw/catch/promise patterns in internals
- enforce Effect-centric architecture and composability
- enforce boundary policy:
  - domain entities must come from `Schema`
  - interfaces are allowed only in public boundary files or method-only internal capability contracts
  - Promise-returning contracts are allowed only at public boundary files
  - `Effect.runPromise` is the only permitted Effect→Promise bridge
  - public API modules cannot import private internals directly
- enforce parsing/process/runtime safety:
  - restrict `JSON.parse` to decode modules and require Schema decode
  - disallow shell-eval process invocation patterns
  - restrict env reads to config/bootstrap
  - force injected clock/random services in internals

### 19.5 Required contract tests

- `--json` mode contract tests:
  - stdout contains valid JSON/JSONL only
  - human-readable diagnostics are emitted to stderr only
- lifecycle contract tests:
  - exactly one terminal event per run
  - exactly one terminal outcome per task-backed driver call
  - no terminal -> non-terminal transitions
  - duplicate terminal emissions are ignored or rejected deterministically
- task actor contract tests:
  - imported `@mill/core/program` task actors work in program host
  - snapshots represent current reduced state
  - steering policies produce honest queue/interrupt/reject snapshots

## 20) Invariants

1. Every run has append-only tier-1 event log.
2. Every task result includes `sessionRef` when backed by an agent session.
3. Engine persists orchestration state only, not full vendor transcripts.
4. Public user APIs are Promise-based façades; internal APIs remain Effect v4-typed.
5. `--json` mode writes machine payloads to `stdout` only; human diagnostics go to `stderr`.
6. Each run/task reaches one terminal outcome and never transitions afterward.
7. All persisted tier-1 events include `schemaVersion` and decode via Schema unions.
8. `Effect.runPromise` is the only permitted Effect→Promise bridge.
9. Runtime/domain internals do not read `process.env`, `Date.now()`, or `Math.random()` directly.
10. `mill run` returns immediately by default.
11. Public docs and new persisted orchestration records use task vocabulary (`task:*`, `taskId`, `tasks`); historical `spawn` names are limited to legacy/driver adapter internals until fully migrated.
12. `spawn-agent` remains internal to `@mill/driver-acp`.

## 21) v0 non-goals

- hosted control plane / multi-tenant server
- built-in template subcommands
- advanced workflow DSLs beyond plain TS
- driver hot-swapping policies inside program logic
- exposing `spawn-agent` as mill public API
- automatic live model discovery in normal CLI help

## 22) Implementation order

1. Core domain schemas + error model
2. RunStore + event append persistence
3. Effect v4 baseline and guardrails
4. Task vocabulary and provider factories
5. Task actor handles, snapshots, and Promise boundary via `.done`
6. Program-host imported `@mill/core/program` context
7. Steering snapshot policies
8. ACP task sessions through internal `spawn-agent`
9. CLI runtime facade over actor-compatible APIs
10. Documentation and examples

## 23) Canonical program example

```ts
import { claude, codex, mill } from "@mill/core/program";

const scan = mill
  .task({
    agent: codex("openai-codex/gpt-5.3-codex"),
    role: "scout",
    system: "You are a code risk analyst. Prioritize highest-impact findings.",
    prompt: "Review src/auth and summarize top security and reliability risks.",
  })
  .start();

const scanResult = await scan.done;

const synth = mill
  .task({
    agent: claude("anthropic/claude-opus-4-6"),
    role: "synth",
    system: "You turn findings into an execution-ready plan.",
    prompt: `Create a step-by-step remediation plan from this analysis:\n\n${scanResult.text}`,
  })
  .start();

await synth.done;
```

This remains plain TypeScript orchestration with `await` / `Promise.all` and no DSL. The actors make state, snapshots, and future steering explicit.
