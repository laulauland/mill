// Per-issue worker — one mill program task per fp issue. Reads issue context
// from env vars set by program.ts, runs the agent in the workspace cwd, and
// returns the agent's text. The orchestrator decides retry/done based on
// whether this program's exit code is 0.

import { codex, task } from "@mill/core/program";

const MODEL = "openai-codex/gpt-5.3-codex";

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (value === undefined || value === "") {
    throw new Error(`required env var ${key} not set`);
  }
  return value;
};

export default async function worker(): Promise<string> {
  const issueId = requireEnv("SYMPHONY_ISSUE_ID");
  const title = requireEnv("SYMPHONY_ISSUE_TITLE");
  const description = process.env.SYMPHONY_ISSUE_DESCRIPTION ?? "";
  const attempt = process.env.SYMPHONY_ATTEMPT ?? "1";

  const prompt = `# fp issue ${issueId} (attempt ${attempt})

## Title
${title}

## Description
${description}

## Working directory
You are running inside the issue's workspace. All edits should land here.

## Done criteria
When the implementation satisfies the description and tests pass, run:
    fp issue update ${issueId} --status done --comment "implemented"
The orchestrator detects the status change on the next tick and stops calling you.

If you cannot complete this turn, leave a clear handoff comment via:
    fp comment add ${issueId} "<what you did, what is left>"
and exit. The orchestrator will retry with backoff.`;

  const out = await task({ agent: codex(MODEL) }).run(prompt);
  if (out.kind !== "agent") throw new Error("expected agent output");
  return out.text;
}
