# Mill Patterns

Common orchestration patterns for core mill programs. Import from `@mill/core/program`, create task actors with `task(...)`, call `.start()`, and await `.done`.

## Parallel Review

```ts
import { claude, task } from "@mill/core/program";

const tasks = [
  task({
    agent: claude("anthropic/claude-opus-4-6"),
    role: "security",
    system: "You are a security reviewer. Report findings with severity ratings.",
    prompt: "Review src/auth/ for security vulnerabilities.",
  }).start(),
  task({
    agent: claude("anthropic/claude-sonnet-4-6"),
    role: "perf",
    system: "You are a performance analyst. Identify bottlenecks and O(n²) patterns.",
    prompt: "Profile src/api/ for performance issues.",
  }).start(),
];

const results = await Promise.all(tasks.map((taskActor) => taskActor.done));
```

## Sequential Pipeline

```ts
import { claude, task } from "@mill/core/program";

const analysisTask = task({
  agent: claude("anthropic/claude-opus-4-6"),
  role: "analyzer",
  system: "You map structure, dependencies, and public interfaces.",
  prompt: "Map all API endpoints in the codebase.",
}).start();
const analysis = await analysisTask.done;

const planTask = task({
  agent: claude("anthropic/claude-sonnet-4-6"),
  role: "planner",
  system: "You design thorough test plans for critical paths and edge cases.",
  prompt: `Design integration tests covering these endpoints:\n\n${analysis.text}`,
}).start();
const plan = await planTask.done;
```

## Fan-out then synthesize

```ts
import { claude, task } from "@mill/core/program";

const reviewTasks = ["frontend", "backend", "infra"].map((area) =>
  task({
    agent: claude("anthropic/claude-sonnet-4-6"),
    role: area,
    system: `You are a ${area} specialist. Review for correctness and actionable risks.`,
    prompt: `Review the ${area} code.`,
  }).start(),
);

const reviews = await Promise.all(reviewTasks.map((taskActor) => taskActor.done));
const context = reviews.map((r) => `[${r.role ?? r.agent}]\n${r.text}`).join("\n\n");

const summaryTask = task({
  agent: claude("anthropic/claude-opus-4-6"),
  role: "synthesizer",
  system: "You synthesize multiple perspectives into clear, prioritized summaries.",
  prompt: `Synthesize these reviews into an actionable summary:\n${context}`,
}).start();
const summary = await summaryTask.done;
```

## Model selection

Use provider factories instead of config: `codex(model)`, `claude(model)`, or `pi(model)`. Match capability to task complexity and vary models across enabled options instead of defaulting to one model.

## Context chaining

Each result has `text` and may include `sessionRef` / `sessionPath` depending on the provider. Pass `result.text` into later prompts; keep session references for later inspection when available.
