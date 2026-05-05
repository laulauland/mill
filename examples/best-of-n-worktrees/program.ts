// Best-of-N with verifier and jj worktrees — spawn N agents in parallel, each
// in its own isolated jj workspace. A deterministic verifier (the test suite)
// picks the winner; losers' worktrees are dropped.
//
// Each candidate runs as a separate `mill run candidate.ts --sync` so its
// agent inherits the worktree's cwd. (Mill's task() does not currently take
// a cwd option; subprogram-per-worktree is the clean workaround and also
// makes each candidate independently observable via `mill ls`.)
//
// Run from the mill repo root:
//   mill run examples/best-of-n-worktrees/program.ts --foreground

import { shell } from "@mill/core/program";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const N = 3;
const PROMPT_PATH = "examples/best-of-n-worktrees/prompt.md";
const VERIFIER = { command: "bun", args: ["test"] };
const ROOT = process.cwd();
const TREES_DIR = `${ROOT}/.bestof-trees`;

type Candidate = { id: number; cwd: string };

const setupWorktree = async (id: number): Promise<Candidate> => {
  const cwd = `${TREES_DIR}/attempt-${id}`;

  await shell({
    command: "jj",
    args: ["workspace", "add", "--name", `bestof-${id}`, cwd],
    cwd: ROOT,
    failOnNonZeroExit: true,
  }).run();

  return { id, cwd };
};

const runCandidate = async (c: Candidate, prompt: string): Promise<void> => {
  await writeFile(`${c.cwd}/.bestof-prompt.md`, prompt);

  const candidatePath = `${ROOT}/examples/best-of-n-worktrees/candidate.ts`;
  const result = await shell({
    command: "mill",
    args: ["run", candidatePath, "--sync", "--quiet"],
    cwd: c.cwd,
    failOnNonZeroExit: false,
  }).run();
  if (result.kind !== "shell") throw new Error("expected shell output");
  console.log(`[best-of-n] attempt-${c.id} mill exit ${result.exitCode}`);
};

const verifyCandidate = async (c: Candidate): Promise<boolean> => {
  const result = await shell({
    command: VERIFIER.command,
    args: VERIFIER.args,
    cwd: c.cwd,
    failOnNonZeroExit: false,
  }).run();
  if (result.kind !== "shell") return false;
  return result.exitCode === 0;
};

const cleanupWorktree = async (c: Candidate): Promise<void> => {
  await shell({
    command: "jj",
    args: ["workspace", "forget", `bestof-${c.id}`],
    cwd: ROOT,
    failOnNonZeroExit: false,
  }).run();
  await rm(c.cwd, { recursive: true, force: true });
};

export default async function bestOfN(): Promise<void> {
  const prompt = await readFile(PROMPT_PATH, "utf8");
  await mkdir(TREES_DIR, { recursive: true });

  const candidates = await Promise.all(Array.from({ length: N }, (_, i) => setupWorktree(i + 1)));

  console.log(`[best-of-n] running ${N} candidates in parallel`);
  await Promise.all(candidates.map((c) => runCandidate(c, prompt)));

  console.log(`[best-of-n] verifying ${N} candidates`);
  const verdicts = await Promise.all(
    candidates.map(async (c) => ({ c, passed: await verifyCandidate(c) })),
  );

  const winners = verdicts.filter((v) => v.passed);
  console.log(`[best-of-n] ${winners.length}/${N} candidates passed verification`);

  if (winners.length === 0) {
    console.log(`[best-of-n] no winner; worktrees left in ${TREES_DIR} for inspection`);
    return;
  }

  const winner = winners[0];
  if (winner === undefined) return;
  console.log(`[best-of-n] winner: attempt-${winner.c.id} at ${winner.c.cwd}`);
  console.log(`[best-of-n] inspect with: jj log -r 'bestof-${winner.c.id}@'`);

  // Drop losers, keep the winner's worktree for the operator to inspect/merge.
  for (const v of verdicts) {
    if (!v.passed) await cleanupWorktree(v.c);
  }
}
