import { claude, codex, pi, shell, task } from "@mill/core/program";

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

const readCurrentRevisionDescription = async (): Promise<string> => {
  const output = await shell({
    command: "jj",
    args: ["log", "-r", "@", "--no-graph", "--template", "description"],
    cwd: "/Users/laurynas-fp/Code/laulauland/mill",
    failOnNonZeroExit: true,
  }).run();

  if (output.kind !== "shell") {
    throw new Error("Expected shell output while reading the current jj revision description.");
  }

  const description = output.stdout.trim();
  if (description.length === 0) {
    throw new Error("Current jj revision has no description to use as the change request.");
  }

  return description;
};

const runResearcher = async (prompt: string): Promise<string> => {
  return (await task({ agent: claude("default") }).run(prompt)).text;
};

const runImplementer = async (prompt: string): Promise<string> => {
  return (await task({ agent: pi() }).run(prompt)).text;
};

const runReviewer = async (prompt: string): Promise<string> => {
  return (await task({ agent: codex("gpt-5.5") }).run(prompt)).text;
};

const buildResearcherPrompt = (changeRequest: string): string => `${repositoryContext}

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
`;

const buildImplementerPrompt = (
  changeRequest: string,
  plan: string,
  previousDraft: string | undefined,
  previousReview: string | undefined,
): string => {
  const head = `${repositoryContext}

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
- Leave a concise summary of changed files and validation results.`;

  if (previousDraft !== undefined && previousReview !== undefined) {
    return `${head}

Previous implementation summary (from a prior iteration of this same change request):

${previousDraft}

Reviewer's blocking feedback to address (in addition to the change request and the research plan):

${previousReview}

Re-implement, addressing the reviewer's feedback. Do not regress prior fixes that were correct.`;
  }

  return head;
};

const buildReviewerPrompt = (
  changeRequest: string,
  currentDraft: string,
  iteration: number,
): string => `${repositoryContext}

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

Verdict format:
- If the implementation is acceptable with no blocking issues, respond with the literal token APPROVED on its own line, then optionally non-blocking suggestions and follow-up commands.
- Otherwise, list blocking issues and exact follow-up commands the implementer should run. Do NOT include the token APPROVED on its own line in this case.`;

const isApproved = (reviewOutput: string): boolean => /^\s*APPROVED\s*$/m.test(reviewOutput);

export default async function runJjChangeWorkflow(): Promise<string> {
  const changeRequest = await readCurrentRevisionDescription();

  const plan = await runResearcher(buildResearcherPrompt(changeRequest));

  let draft = await runImplementer(
    buildImplementerPrompt(changeRequest, plan, undefined, undefined),
  );
  let reviewOutput = "";

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    reviewOutput = await runReviewer(buildReviewerPrompt(changeRequest, draft, iteration));

    if (isApproved(reviewOutput)) {
      console.log(reviewOutput);
      return reviewOutput;
    }

    if (iteration === MAX_ITERATIONS - 1) {
      break;
    }

    draft = await runImplementer(buildImplementerPrompt(changeRequest, plan, draft, reviewOutput));
  }

  console.log(reviewOutput);
  return reviewOutput;
}
