# mill

A simple TypeScript runtime for orchestrating subagent work. The orchestrator writes a short program that spawns agents — you review it before it runs.

## How it works

You talk to your main agent (in Pi, Claude Code, OpenCode etc.). When work needs to be farmed out, it writes a mill program: a TypeScript file that spawns subagents with specific instructions. You see the code before it executes.

## Quick example

```ts
const analysis = await mill.spawn({
  agent: "analyzer",
  systemPrompt: "Map key risks and unknowns.",
  prompt: "Analyze the auth module and summarize weak points.",
  model: "anthropic/claude-sonnet-4-5",
});

const plan = await mill.spawn({
  agent: "planner",
  systemPrompt: "Turn findings into a concrete implementation plan.",
  prompt: `Use this analysis to propose fixes:\n\n${analysis.text}`,
  model: "anthropic/claude-opus-4-6",
});

console.log(plan.text);
```

```bash
mill run review.ts                 # returns runId, executes in background
mill watch --run abc123            # stream events live
mill watch --run abc123 --channel io
mill run review.ts --sync          # or block until done
```

## CLI

```
mill run <program.ts> [--sync] [--json] [--driver <name>]
mill status <runId>                    show run state
mill wait <runId> --timeout            block until complete/failed/cancelled
mill watch [--run <runId>]             watch streams (default: events)
  --channel events|io|all              choose stream channel
  --source driver|program              io source filter (io/all only)
  --spawn <spawnId>                    io spawn filter (io/all only)
mill cancel <runId>                    mark cancelled + kill worker process tree
mill ls [--status <filter>]            list runs
mill init [--global]                   generate starter config (local or ~/.mill/config.ts)
```

All commands accept `--json` for machine-readable output on stdout (diagnostics go to stderr).

## FAQ

**Couldn't I just do this with bash and claude -p?**
Yes — that's the point. The orchestrator can use any language to express a plan. TypeScript is optional; it's just easy to read and lets mill hook into the spawn calls to offer structured output, event logs, and session replay.

**How is this different from Claude Code tasks?**
Tasks are scoped to Claude Code. Mill programs are portable across drivers — same program can spawn Claude, Codex, or pi subagents. The program is also a readable artifact you confirm before execution, not an internal dispatch.

**Do I have to write the programs myself?**
No. The orchestrator writes them. You review and confirm.

## Configuration

`mill.config.ts` gives the orchestrator precise instructions — model preferences per task type, driver selection, authoring conventions. The orchestrator reads the config and makes choices accordingly.

```bash
mill init                # creates ./mill.config.ts
mill init --global       # creates ~/.mill/config.ts
```

Resolved in order: `./mill.config.ts` → walk up to repo root → `~/.mill/config.ts` → built-in defaults.

## Drivers

Drivers translate `mill.spawn()` into whatever protocol the agent needs. Ships with Claude, Codex, and pi drivers. Write your own by implementing a codec that parses process output into structured events.

| Package               | Purpose                                    |
| --------------------- | ------------------------------------------ |
| `@mill/core`          | Engine, lifecycle, API, config             |
| `@mill/cli`           | CLI commands                               |
| `@mill/driver-claude` | Claude driver                              |
| `@mill/driver-codex`  | Codex driver                               |
| `@mill/driver-pi`     | Pi driver                                  |
| `pi-mill`             | Pi extension for mill as execution backend |

## Internals

Built on [Effect](https://effect.website). Public API is Promise-based (`src/public/**/*.api.ts`). Engine, drivers, and persistence are Effect-first with Schema-validated domain types.

Run storage: `~/.mill/runs/<runId>/` — metadata, NDJSON event log, results, per-spawn session transcripts.

## Development

```bash
bun install
bun test
bun run check         # ast-grep + lint + format + typecheck + test
```
