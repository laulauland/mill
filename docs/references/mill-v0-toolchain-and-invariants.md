# mill v0 Toolchain, Invariants, Non-goals, and Order (Sections 19–23)

_Source: `SPEC.md` (verbatim split for cedar-style docs tree)._

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

## 21) v0 non-goals

- hosted control plane / multi-tenant server
- built-in template subcommands
- advanced workflow DSLs beyond plain TS
- driver hot-swapping policies inside program logic

## 22) Implementation order

1. Core domain schemas + error model
2. RunStore + event append persistence
3. Generic process driver + one codec (pi or claude)
4. Engine submit/status/wait/watch/cancel
5. Worker process + detached `run`
6. `inspect` and `--session` bridge
7. Extension hooks
8. Guardrail toolchain + rules/tests

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
