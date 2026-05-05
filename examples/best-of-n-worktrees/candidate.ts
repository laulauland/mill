// Leaf program — runs one agent task with the prompt from .bestof-prompt.md
// in the current worktree. Invoked by program.ts via `mill run`.

import { codex, task } from "@mill/core/program";
import { readFile } from "node:fs/promises";

const MODEL = "openai-codex/gpt-5.3-codex";

export default async function candidate(): Promise<string> {
  const prompt = await readFile(".bestof-prompt.md", "utf8");
  const out = await task({ agent: codex(MODEL) }).run(
    `${prompt}\n\nWork in the current directory. Commit your changes with \`jj describe\` and \`jj new\` as you go. The verifier will run \`bun test\` from this directory.`,
  );
  if (out.kind !== "agent") throw new Error("expected agent output");
  return out.text;
}
