# mill

A runtime for executing TypeScript programs that can spawn agents. Write plain TS with `await` and `Promise.all` — mill handles the lifecycle, persistence, and observability.

## What you can do

**Orchestrate agents in plain TypeScript** — no DSL, no YAML, just sequential and parallel `await` calls with a single injected `mill.spawn()` API.

**Run async by default** — `mill run` returns a `runId` immediately and executes in a detached worker. Attach later with `watch`, `wait`, or `inspect`.

**Swap agent backends** — drivers are generic adapters. Ship with pi, Claude, and Codex drivers. Write your own by implementing a codec that parses process output into structured events.

**Observe everything** — structured NDJSON event log per run, real-time streaming via `mill watch`, and full session replay via `mill inspect --session`. Use the built-in `mill watch` or build a TUI around it.

## Quick example

```ts
// review.ts
const scan = await mill.spawn({
  agent: "scout",
  systemPrompt: "You are a code risk analyst.",
  prompt: "Review src/auth and summarize top security risks.",
  model: "openai/gpt-5.3-codex",
});

const plan = await mill.spawn({
  agent: "planner",
  systemPrompt: "You turn findings into an execution-ready plan.",
  prompt: `Create remediation steps from:\n\n${scan.text}`,
  model: "anthropic/claude-opus-4.6",
});

console.log(plan.text);
```

```bash
mill run review.ts           # returns runId, executes in background
mill watch abc123            # stream events live
mill run review.ts --sync    # or block until done
```

## CLI

```
mill run <program.ts> [--sync] [--json] [--driver <name>]
mill status <runId>           show run state
mill wait <runId> --timeout   block until complete/failed/cancelled
mill watch <runId>            stream tier-1 events (NDJSON with --json)
mill inspect <id>[.<spawnId>] inspect run or spawn detail
mill inspect <id> --session   resolve full agent session via driver
mill cancel <runId>           mark cancelled + kill worker process tree
mill ls [--status <filter>]   list runs
mill init                     generate starter mill.config.ts
```

All commands accept `--json` for machine-readable output on stdout (diagnostics go to stderr).

## Configuration

```ts
// mill.config.ts
import { defineConfig, processDriver, piCodec } from "@mill/core";

export default defineConfig({
  defaultDriver: "pi",
  defaultModel: "openai/gpt-5.3-codex",
  defaultExecutor: "direct",
  drivers: {
    pi: processDriver({
      command: "pi",
      args: ["-p"],
      codec: piCodec(),
    }),
  },
});
```

Resolved in order: `./mill.config.ts` → walk up to repo root → `~/.mill/config.ts` → built-in defaults.

## Packages

| Package               | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `@mill/core`          | Engine, run lifecycle, public API, config loader   |
| `@mill/cli`           | CLI commands wrapping core                         |
| `@mill/driver-pi`     | Process driver for pi agent                        |
| `@mill/driver-claude` | Driver for Claude                                  |
| `@mill/driver-codex`  | Driver for Codex                                   |
| `pi-mill`             | Pi extension integrating mill as execution backend |

## Architecture

```
mill program (TS)
  → executor (direct | vm)
    → engine (lifecycle, API injection, events, persistence)
      → driver (generic process/http adapter + codec)
        → agent process
```

Layers are orthogonal: executor decides _where_ the program runs, driver decides _how_ spawns invoke agents, extensions add hooks and extra API surface.

### Run storage

```
~/.mill/runs/<runId>/
  run.json             metadata (status is canonical)
  events.ndjson        append-only structured event log
  result.json          final output
  program.ts           copied source
  worker.pid           detached worker pid (best effort)
  logs/worker.log      worker lifecycle breadcrumbs
  logs/cancel.log      cancel/kill lifecycle breadcrumbs
  sessions/<spawn>.jsonl  per-spawn pi session transcripts (pi driver)
```

For operations/debugging conventions, see `docs/references/mill-v0-operations-and-troubleshooting.md`.

### Internals

Built on [Effect](https://effect.website). The public API (`src/public/**/*.api.ts`) exposes Promise-based contracts. Everything else — engine, drivers, persistence — is Effect-first with Schema-validated domain types. `Runtime.runPromise` is the only bridge between the two worlds.

## Development

```bash
bun install
bun test                    # run tests
bun run check               # full pipeline: ast-grep + lint + format + typecheck + test
bun run typecheck            # tsgo --noEmit
bun run lint:ast-grep        # structural guardrails
bun run lint:boundary        # public/internal boundary enforcement
bun run format               # oxfmt
```

Toolchain: ast-grep (structural rules), oxlint, oxfmt, tsgo, bun test.
