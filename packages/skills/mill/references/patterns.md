# Mill Patterns

Common orchestration patterns for pi-mill programs. `mill.task(input)` creates a task actor. Call `.start()` and await `.done` for the final result.

## Parallel Review

```ts
const tasks = [
  mill.task({
    agent: "security",
    system: "You are a security reviewer. Report findings with severity ratings.",
    prompt: "Review src/auth/ for security vulnerabilities.",
    model: "anthropic/claude-opus-4-6",
    step: 0,
  }),
  mill.task({
    agent: "perf",
    system: "You are a performance analyst. Identify bottlenecks and O(n²) patterns.",
    prompt: "Profile src/api/ for performance issues.",
    model: "anthropic/claude-sonnet-4-6",
    step: 1,
  }),
];

tasks.forEach((task) => task.start());
const results = await Promise.all(tasks.map((task) => task.done));
```

## Sequential Pipeline

```ts
const analysisTask = mill
  .task({
    agent: "analyzer",
    system: "You map structure, dependencies, and public interfaces.",
    prompt: "Map all API endpoints in the codebase.",
    model: "anthropic/claude-opus-4-6",
    step: 0,
  })
  .start();
const analysis = await analysisTask.done;

const planTask = mill
  .task({
    agent: "planner",
    system: "You design thorough test plans for critical paths and edge cases.",
    prompt: `Design integration tests covering these endpoints:\n\n${analysis.text}`,
    model: "anthropic/claude-sonnet-4-6",
    step: 1,
  })
  .start();
const plan = await planTask.done;
```

## Fan-out then Synthesize

```ts
const reviewTasks = ["frontend", "backend", "infra"].map((area, step) =>
  mill
    .task({
      agent: area,
      system: `You are a ${area} specialist. Review for correctness and actionable risks.`,
      prompt: `Review the ${area} code.`,
      model: "anthropic/claude-sonnet-4-6",
      step,
    })
    .start(),
);

const reviews = await Promise.all(reviewTasks.map((task) => task.done));
const context = reviews.map((r) => `[${r.agent}]\n${r.text}`).join("\n\n");

const summaryTask = mill
  .task({
    agent: "synthesizer",
    system: "You synthesize multiple perspectives into clear, prioritized summaries.",
    prompt: `Synthesize these reviews into an actionable summary:\n${context}`,
    model: "anthropic/claude-opus-4-6",
    step: reviews.length,
  })
  .start();
const summary = await summaryTask.done;
```

## Model Selection

Models use `provider/model-id` format. Match capability to task complexity and vary models across enabled options instead of defaulting to one model.

## Context Chaining

Each result has `text` and `sessionPath`. Pass `result.text` into later prompts; point agents at `sessionPath` when they need deeper context.
