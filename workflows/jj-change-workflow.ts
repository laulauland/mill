import { claude, codex, pi, task } from "@mill/core/program";

const MAX_ITERATIONS = 3;

const repositoryContext = `
Repository: /Users/laurynas-fp/Code/laulauland/mill
Constraints:
- Preserve current Mill CLI behavior and command surface unless the change request explicitly calls out a necessary change.
- Keep the CLI package source-first: packages/cli/package.json bin points at ./src/mill.ts; do not add stale dist exports.
- Follow repo docs: CONTEXT.md, docs/spec.md, docs/rewrite-plan.md, docs/adr/.
- Public package layout conventions: public APIs are *.api.ts plus index.ts; no *.effect.ts / *.schema.ts suffixes.
- Use jj, not git, for version-control inspection.
- Validate with focused typechecks/tests and report exactly what passed or failed.
- Agent runtime model selection must be explicit and fail-fast: resolve the requested model against ACP configOptions, call agent.setConfigOption(sessionId, modelConfigId, resolvedValue) before prompting, and do not rely on spawn-agent's prompt(modelPreference) path because it swallows invalid model-selection failures.
`;

const readCurrentRevisionDescription = (): string => {
  const proc = Bun.spawnSync({
    cmd: ["jj", "log", "-r", "@", "--no-graph", "--template", "description"],
    cwd: "/Users/laurynas-fp/Code/laulauland/mill",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (!proc.success) {
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    throw new Error(`Failed to read current jj revision description: ${stderr}`);
  }

  const description = new TextDecoder().decode(proc.stdout).trim();
  if (description.length === 0) {
    throw new Error("Current jj revision has no description to use as the change request.");
  }

  return description;
};

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

const changeRequest = readCurrentRevisionDescription();

const research = task({
  agent: claude("claude-opus-4.7"),
  prompt: `${repositoryContext}

Step 1 — research and plan only. Do not modify files.

Change request from the current jj revision description:

${changeRequest}

Research the requested change against the current repository. Inspect installed package docs/types/source as needed.

Produce a concise implementation plan. Include:
- relevant files and APIs,
- exact behavior to preserve or change,
- command/test plan,
- risks or unknowns for the implementer,
- any mismatch between docs and code.
`,
}).start();

const researchSnapshot = await research.done;
const plan = resultText(researchSnapshot);

const implementation = task({
  agent: pi("gpt-5.5"),
  prompt: `${repositoryContext}

Step 2 — implement.

Change request from the current jj revision description:

${changeRequest}

Research plan from the researcher task:

${plan}

Implement the requested change.

Requirements:
- Keep changes focused on the change request.
- Preserve task/event vocabulary and public API shape unless the change request says otherwise.
- If you touch provider/runtime wiring, ensure model selection is explicit and fail-fast: do not pass modelPreference to agent.prompt; resolve the model option and call agent.setConfigOption before prompting.
- Add or update tests if practical; otherwise document manual validation.
- Run format/typecheck/export checks that are appropriate.
- Leave a concise summary of changed files and validation results.
`,
}).start();

const implementationSnapshot = await implementation.done;
const implementationSummary = resultText(implementationSnapshot);

const review = task({
  agent: codex("gpt-5.5"),
  prompt: `${repositoryContext}

Step 3 — review only. Do not implement unless explicitly necessary to verify a finding.

Change request from the current jj revision description:

${changeRequest}

Implementation summary/result (iteration ${iteration + 1} of up to ${MAX_ITERATIONS}):

${currentDraft}

Review focus:
- Implementation satisfies the change request, not an older hardcoded workflow prompt.
- Behavior matches docs/spec.md or clearly documents any unavoidable mismatch.
- Existing CLI/runtime behavior is preserved where in scope.
- No stale dist/bin/export metadata is reintroduced.
- ACP model selection remains explicit and fail-fast if provider/runtime code is touched.
- Tests/checks are sufficient.

Return: verdict, blockers, non-blocking suggestions, and exact follow-up commands if any.
`,
}).start();

await review.done;
