# mill

A TypeScript runtime for orchestrating agent tasks. A mill program creates task actors, starts them, observes snapshots, and lets the CLI persist the run so you can `status`, `wait`, `watch`, `cancel`, and `ls` it later.

## How it works

You talk to your main agent (in Pi, Claude Code, OpenCode, etc.). When work needs to be delegated, it writes a short mill program. You review that TypeScript before it runs. Each delegated unit is a task actor.

## Install

```bash
brew install laulauland/tap/mill
```

Or build from source (requires [Bun](https://bun.sh)):

```bash
git clone https://github.com/laulauland/mill.git && cd mill
bun install
VERSION=$(node -p 'require("./packages/cli/package.json").version')
bun build --compile packages/cli/src/mill.ts --outfile mill --define "__MILL_VERSION__=\"$VERSION\""
mv mill ~/.local/bin/  # or anywhere on your PATH
```

Then scaffold a config:

```bash
mill init              # creates ./mill.config.ts in current project
mill init --global     # creates ~/.mill/config.ts (shared default)
```

The config sets your default driver, model preferences, and authoring guidance. See [Configuration](#configuration) for details.

## Quick example

```ts
import { claude, codex } from "@mill/core";

const analysis = mill
  .task({
    agent: codex("openai-codex/gpt-5.3-codex"),
    role: "analyzer",
    system: "Map key risks and unknowns.",
    prompt: "Analyze the auth module and summarize weak points.",
  })
  .start();

const analysisResult = await analysis.done;

const plan = mill
  .task({
    agent: claude("anthropic/claude-opus-4-6"),
    role: "planner",
    system: "Turn findings into a concrete implementation plan.",
    prompt: `Use this analysis to propose fixes:\n\n${analysisResult.text}`,
  })
  .start();

return await plan.done;
```

```bash
mill run review.ts                 # returns runId, executes in background
mill watch --run abc123            # stream events live
mill watch --run abc123 --channel io
mill run review.ts --sync          # or block until done
```

## Task actors

`mill.task(...)` creates a task actor. It is synchronous and cheap. `.start()` begins execution and `.done` is the Promise boundary for the final `TaskResult`.

```ts
const task = mill
  .task({
    agent: codex("openai-codex/gpt-5.3-codex"),
    system: "You inspect code.",
    prompt: "Review src/auth.",
    steering: "queue",
  })
  .start();

task.subscribe((snapshot) => {
  console.log(snapshot.status, snapshot.text);
});

return await task.done;
```

Snapshots are the actor's current reduced state: status, accumulated text, queue, session pointer, result, or error. Events are the append-only history; snapshots are what is true now.

Steering is represented with task commands:

```ts
task.send({
  type: "message",
  mode: "interrupt",
  content: "Stop and focus only on token handling.",
});
```

Current state: core task actors model `queue`, `interrupt`, and `reject` policies in snapshots. Program-host tasks mirror that actor-shaped behavior for authored programs. The ACP driver has session-level multi-turn and cancel support through its internal `spawn-agent` integration, but fully durable end-to-end steering is still incremental.

## Agents and provider factories

Tasks use an `agent` provider object. Built-in helpers are exported from `@mill/core`:

```ts
import { claude, codex, pi } from "@mill/core";

codex("openai-codex/gpt-5.3-codex");
claude("anthropic/claude-opus-4-6");
pi("your-pi-model-id");
```

The provider selects the driver and model. `role` is the human-readable task role, `system` describes how the agent should behave, and `prompt` describes the work.

## CLI

```
mill run <program.ts> [--sync] [--json] [--driver <name>]
mill status <runId>                    show run state
mill wait <runId> --timeout            block until complete/failed/cancelled
mill watch [--run <runId>]             watch streams (default: events)
  --channel events|io|all              choose stream channel
  --source driver|program              io source filter (io/all only)
  --spawn <spawnId>                    io spawn/task filter (io/all only; storage still uses legacy ids)
mill cancel <runId>                    mark cancelled + kill worker process tree
mill ls [--status <filter>]            list runs
mill init [--global]                   generate starter config (local or ~/.mill/config.ts)
```

All commands accept `--json` for machine-readable output on stdout (diagnostics go to stderr).

`mill --help` and `mill <command> --help` include a **Models** section for the selected driver (`defaultDriver` from resolved config, or `--driver` override on command help). The list is sourced from that driver's registration metadata, so driver registration informs the CLI/main agent about available models. Live model discovery is not part of normal help yet.

## Use with Claude Code

[Install mill](#install), then add the skill:

```bash
npx skills add laulauland/mill
```

This teaches Claude Code how to write and run mill programs. When you ask it to farm out work to subagents, it will author a `.ts` program using task actors, show it to you for confirmation, and execute it via the CLI.

## Use with pi

[Install mill](#install), then add the [pi-mill](https://github.com/laulauland/mill/tree/main/packages/pi-mill) extension:

```bash
pi install npm:pi-mill
```

This registers a `subagent` tool in pi. When the agent needs to delegate work, it writes a mill program and executes it. The extension also adds monitoring: `/mill` opens an in-session overlay, and `pi --mill` launches a standalone run monitor.

## FAQ

**Couldn't I just do this with bash and claude -p?**
Yes — that's the point. The orchestrator can use any language to express a plan. TypeScript is optional; it's just easy to read and lets mill hook into task actors to offer structured output, event logs, and session replay.

**How is this different from Claude Code tasks?**
Claude Code tasks are scoped to Claude Code. Mill programs are portable across drivers — the same program can run Claude, Codex, or pi task agents. The program is also a readable artifact you confirm before execution, not an internal dispatch.

**Do I have to write the programs myself?**
No. The orchestrator writes them. You review and confirm.

## Configuration

`mill.config.ts` gives the orchestrator precise instructions — model preferences per task type, driver selection, authoring conventions. The orchestrator reads the config and makes choices accordingly.

```bash
mill init                # creates ./mill.config.ts
mill init --global       # creates ~/.mill/config.ts
```

Resolved in order: `./mill.config.ts` → walk up to repo root → `~/.mill/config.ts` → built-in defaults.

Recursion guard:

- `maxRunDepth` (default `1`) limits nested `mill run` invocations by depth.
- Mill tracks depth with `MILL_RUN_DEPTH` in worker/program child environments.
- If a nested invocation exceeds `maxRunDepth`, `mill run` is rejected before submission.

## Drivers

Drivers translate task execution into whatever protocol the agent needs. Mill ships a unified ACP driver package that bundles Claude, Codex, and pi registrations. The ACP implementation delegates protocol/session work to `spawn-agent`, which is an internal dependency of `@mill/driver-acp`, not a public mill API.

| Package            | Purpose                                                 |
| ------------------ | ------------------------------------------------------- |
| `@mill/core`       | Engine, lifecycle, task actor API, config               |
| `@mill/cli`        | CLI commands                                            |
| `@mill/driver-acp` | Unified ACP-based Claude / Codex / pi driver registries |
| `pi-mill`          | Pi extension for mill as execution backend              |

Model catalog source by built-in driver registration:

- `pi` (`@mill/driver-acp`): reads `~/.pi/agent/settings.json` (`enabledModels`) by default, unless overridden in config.
- `claude` (`@mill/driver-acp`): built-in default catalog (`sonnet`, `opus`, `haiku`) unless overridden in config.
- `codex` (`@mill/driver-acp`): built-in default catalog (`openai-codex/gpt-5.3-codex`) unless overridden in config.

## Internals

Built on Effect v4 / effect-smol. Public boundaries expose Promise ergonomics through actor `.done` and runtime facade methods. Engine, drivers, persistence, task actor internals, and schemas are Effect-first.

Run storage: `~/.mill/runs/<runId>/` — metadata, NDJSON event log, results, and task/driver session pointers. Some persisted event names still use the historical `spawn:*` vocabulary while the public API moves to task actors.

## Development

```bash
bun install
bun test
bun run check         # ast-grep + lint + format + typecheck + test
```
