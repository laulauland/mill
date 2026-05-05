# Sample PRD: tiny number-guessing CLI

Build a Bun TypeScript CLI in `./guess/` that:

1. On launch, picks a secret integer in [1, 100].
2. Reads guesses from stdin one per line.
3. After each guess, prints `higher`, `lower`, or `correct`.
4. On `correct`, prints how many guesses it took and exits 0.
5. Has at least one passing test in `./guess/guess.test.ts`.

Acceptance: `bun test ./guess` is green and `echo 50 | bun ./guess/index.ts`
produces a hint or correct line.

When the acceptance criteria are met, write `done.` on its own line in
LEARNINGS.md.
