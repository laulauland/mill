// Ralph loop — a single coding agent runs in a tight outer loop, re-reading
// PRD.md and LEARNINGS.md every iteration, asked to make ONE increment of
// progress per turn. Durable state lives on disk: the agent has no memory of
// past iterations beyond what it has written to LEARNINGS.md.
//
// Cancel with `mill cancel <taskId>` or Ctrl-C in --foreground mode. Stops
// when LEARNINGS.md contains a line `done.` on its own.
//
// Run from this directory:
//   mill run program.ts --foreground

import { codex, task } from "@mill/core/program";
import { readFile } from "node:fs/promises";

const PRD_PATH = "PRD.md";
const LEARNINGS_PATH = "LEARNINGS.md";
const MAX_ITERATIONS = 50;
const MODEL = "openai-codex/gpt-5.3-codex";

const buildPrompt = async (iteration: number): Promise<string> => {
  const prd = await readFile(PRD_PATH, "utf8");
  const learnings = await readFile(LEARNINGS_PATH, "utf8").catch(() => "");

  return `# Ralph iteration ${iteration}

You are working one increment toward the spec below. Read it, read your prior
LEARNINGS, then pick ONE concrete next step and ship it. Update LEARNINGS.md
at the end of the turn with what you did and what should come next.

## PRD
${prd}

## LEARNINGS so far
${learnings}

## Rules
- One increment per turn.
- Prefer a smaller working change to a larger half-finished one.
- Update LEARNINGS.md before yielding.
- If the PRD is complete, write a single line "done." in LEARNINGS.md and stop.`;
};

const isDone = async (): Promise<boolean> => {
  const learnings = await readFile(LEARNINGS_PATH, "utf8").catch(() => "");
  return /^\s*done\.\s*$/m.test(learnings);
};

export default async function ralph(): Promise<void> {
  let stopped = false;
  process.on("SIGTERM", () => {
    stopped = true;
  });
  process.on("SIGINT", () => {
    stopped = true;
  });

  for (let i = 1; i <= MAX_ITERATIONS && !stopped; i++) {
    // Fresh task each iteration → fresh codex thread → no context carryover.
    // This is the pattern's core property: the agent re-discovers the world
    // from PRD.md + LEARNINGS.md each turn, so durable state must be on disk.
    const out = await task({ agent: codex(MODEL) }).run(await buildPrompt(i));
    if (out.kind !== "agent") throw new Error("expected agent output");
    console.log(`[ralph] iteration ${i} produced ${out.text.length} chars`);

    if (await isDone()) {
      console.log("[ralph] PRD reports done");
      return;
    }
  }

  if (stopped) console.log("[ralph] stopped by signal");
  else console.log(`[ralph] hit MAX_ITERATIONS=${MAX_ITERATIONS}`);
}
