import { claude, codex, pi, task } from "@mill/core/program";

const repositoryContext = `
Repository: /Users/laurynas-fp/Code/laulauland/mill
Goal: replace the hand-rolled CLI argument parsing in packages/cli/src/mill.ts with Effect v4's CLI package.
Constraints:
- Preserve current Mill CLI behavior and command surface unless the implementation plan explicitly calls out a necessary change.
- Keep the CLI package source-first: packages/cli/package.json bin points at ./src/mill.ts; do not add stale dist exports.
- Follow repo docs: CONTEXT.md, docs/spec.md, docs/rewrite-plan.md, docs/adr/.
- Public package layout conventions: public APIs are *.api.ts plus index.ts; no *.effect.ts / *.schema.ts suffixes.
- Validate with at least: bun run --cwd packages/cli typecheck, bun run lint:exports, and targeted CLI tests if added.
- Agent runtime model selection must be explicit: resolve the requested model against ACP configOptions, call agent.setConfigOption(sessionId, modelConfigId, resolvedValue) before prompting, and do not rely on spawn-agent's prompt(modelPreference) path because it swallows invalid model-selection failures.
`;

const resultText = (value: unknown): string => {
  if (typeof value !== "object" || value === null) {
    return String(value ?? "");
  }

  const maybeResult = value as {
    readonly result?: { readonly text?: unknown };
    readonly text?: unknown;
  };
  if (typeof maybeResult.result?.text === "string") {
    return maybeResult.result.text;
  }
  if (typeof maybeResult.text === "string") {
    return maybeResult.text;
  }

  return JSON.stringify(value, null, 2);
};

const research = task({
  agent: claude("claude-opus-4.7"),
  prompt: `${repositoryContext}

Step 1 — research and plan only.

Quickly research the Effect v4 CLI APIs available to this project. Inspect installed package docs/types/source as needed; do not modify files.

Produce a concise implementation plan for replacing the current manual parseArgs/usage flow in packages/cli/src/mill.ts with Effect v4 CLI primitives. Include:
- relevant imports/modules and API shapes,
- command/option mapping for run/status/watch/cancel/ls/wait,
- how to preserve current stdout/stderr and exit-code behavior,
- validation/typecheck commands,
- risks or unknowns for the implementer.
- a note to preserve/fix explicit ACP model selection if the CLI work touches runtime wiring.
`,
}).start();

const researchSnapshot = await research.done;
const plan = resultText(researchSnapshot);

const implementation = task({
  agent: pi("gpt-5.5"),
  prompt: `${repositoryContext}

Step 2 — implement.

Use this research plan from the Claude task:

${plan}

Implement the migration from manual CLI parsing to Effect v4's CLI package.

Requirements:
- Modify packages/cli/src/mill.ts and package metadata only if needed.
- Preserve command behavior: run, status, watch, cancel, ls, wait, --tasks-dir, --shallow, --include, --exclude, -h/--help.
- If you touch provider/runtime wiring, ensure model selection is explicit and fail-fast: do not pass modelPreference to agent.prompt; resolve the model option and call agent.setConfigOption before prompting.
- Add or update tests if the repo has an obvious CLI test pattern; otherwise keep the change minimal and document what you validated.
- Run format/typecheck/export checks that are appropriate.
- Leave a concise summary of changed files and validation results.
`,
}).start();

const implementationSnapshot = await implementation.done;
const implementationSummary = resultText(implementationSnapshot);

const review = task({
  agent: codex("gpt-5.5"),
  prompt: `${repositoryContext}

Step 3 — review only.

Review the implementation produced by the Pi task. Do not make changes unless explicitly necessary to verify a finding.

Implementation summary/result:

${implementationSummary}

Review focus:
- Effect v4 CLI API usage is idiomatic and compiles.
- Current Mill CLI behavior is preserved.
- Help text, option parsing, stdout/stderr, and exit codes remain sane.
- No stale dist/bin/export metadata is reintroduced.
- ACP model selection remains explicit and fail-fast; invalid requested models must not silently fall back through spawn-agent's swallowed modelPreference path.
- Tests/checks are sufficient.

Return: verdict, blockers, non-blocking suggestions, and exact follow-up commands if any.
`,
}).start();

await review.done;
