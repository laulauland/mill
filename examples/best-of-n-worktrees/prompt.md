# Task

Implement a `levenshtein(a: string, b: string): number` function in
`./src/levenshtein.ts` and matching tests in `./src/levenshtein.test.ts`
that pass with `bun test`.

Constraints:

- O(min(a.length, b.length)) memory.
- Handle empty strings, identical strings, and strings of different length.
- Pure function; no I/O.
