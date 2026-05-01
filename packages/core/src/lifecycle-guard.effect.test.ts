import { describe, expect, it } from "bun:test";
import { Effect, type Effect as EffectType } from "effect";
import { decodeRunIdSync, decodeTaskIdSync } from "./run.schema";
import { runWithRuntime } from "./test-runtime";
import {
  applyLifecycleTransition,
  initialLifecycleGuardState,
  type LifecycleGuardState,
} from "./lifecycle-guard.effect";

const runEffect = <A, E>(effect: EffectType<A, E>): Promise<A> => runWithRuntime(effect);

const runId = decodeRunIdSync("run_lifecycle_guard");
const taskId = decodeTaskIdSync("task_lifecycle_guard");

const runStartEvent = {
  schemaVersion: 1 as const,
  runId,
  sequence: 1,
  timestamp: "2026-02-23T20:00:00.000Z",
  type: "run:start" as const,
  payload: {
    programPath: "/tmp/program.ts",
  },
};

describe("lifecycle guard transitions", () => {
  it("accepts a valid non-terminal to terminal progression", async () => {
    let state: LifecycleGuardState = initialLifecycleGuardState;

    state = await runEffect(applyLifecycleTransition(state, runStartEvent));
    state = await runEffect(
      applyLifecycleTransition(state, {
        schemaVersion: 1,
        runId,
        sequence: 2,
        timestamp: "2026-02-23T20:00:01.000Z",
        type: "run:status",
        payload: {
          status: "running",
        },
      }),
    );
    state = await runEffect(
      applyLifecycleTransition(state, {
        schemaVersion: 1,
        runId,
        sequence: 3,
        timestamp: "2026-02-23T20:00:02.000Z",
        type: "task:start",
        payload: {
          taskId,
          input: {
            role: "scout",
            system: "You are concise.",
            prompt: "summarize",
            model: "openai/gpt-5.3-codex",
            provider: "pi",
          },
        },
      }),
    );
    state = await runEffect(
      applyLifecycleTransition(state, {
        schemaVersion: 1,
        runId,
        sequence: 4,
        timestamp: "2026-02-23T20:00:03.000Z",
        type: "task:complete",
        payload: {
          taskId,
          result: {
            text: "done",
            sessionRef: "session/scout",
            role: "scout",
            model: "openai/gpt-5.3-codex",
            provider: "pi",
            exitCode: 0,
          },
        },
      }),
    );

    const terminalState = await runEffect(
      applyLifecycleTransition(state, {
        schemaVersion: 1,
        runId,
        sequence: 5,
        timestamp: "2026-02-23T20:00:04.000Z",
        type: "run:complete",
        payload: {
          result: {
            runId,
            status: "complete",
            startedAt: "2026-02-23T20:00:00.000Z",
            completedAt: "2026-02-23T20:00:04.000Z",
            tasks: [
              {
                text: "done",
                sessionRef: "session/scout",
                role: "scout",
                model: "openai/gpt-5.3-codex",
                provider: "pi",
                exitCode: 0,
              },
            ],
          },
        },
      }),
    );

    expect(terminalState.runTerminal).toBe("run:complete");
  });

  it("rejects terminal -> non-terminal transitions", async () => {
    const terminalState = await runEffect(
      applyLifecycleTransition(initialLifecycleGuardState, {
        ...runStartEvent,
        type: "run:complete",
        sequence: 2,
        payload: {
          result: {
            runId,
            status: "complete",
            startedAt: "2026-02-23T20:00:00.000Z",
            completedAt: "2026-02-23T20:00:01.000Z",
            tasks: [],
          },
        },
      }),
    );

    const failure = await runEffect(
      Effect.flip(
        applyLifecycleTransition(terminalState, {
          schemaVersion: 1,
          runId,
          sequence: 3,
          timestamp: "2026-02-23T20:00:02.000Z",
          type: "run:status",
          payload: {
            status: "running",
          },
        }),
      ),
    );

    expect(failure).toMatchObject({
      _tag: "LifecycleInvariantError",
      runId,
    });
  });

  it("rejects duplicate run terminal emissions deterministically", async () => {
    const terminalState = await runEffect(
      applyLifecycleTransition(initialLifecycleGuardState, {
        ...runStartEvent,
        type: "run:failed",
        sequence: 2,
        payload: {
          message: "boom",
        },
      }),
    );

    const failure = await runEffect(
      Effect.flip(
        applyLifecycleTransition(terminalState, {
          schemaVersion: 1,
          runId,
          sequence: 3,
          timestamp: "2026-02-23T20:00:02.000Z",
          type: "run:cancelled",
          payload: {},
        }),
      ),
    );

    expect(failure).toMatchObject({
      _tag: "LifecycleInvariantError",
      runId,
    });
  });

  it("rejects duplicate task terminal emissions for a single task", async () => {
    let state = await runEffect(
      applyLifecycleTransition(initialLifecycleGuardState, {
        ...runStartEvent,
        sequence: 1,
      }),
    );

    state = await runEffect(
      applyLifecycleTransition(state, {
        schemaVersion: 1,
        runId,
        sequence: 2,
        timestamp: "2026-02-23T20:00:01.000Z",
        type: "task:start",
        payload: {
          taskId,
          input: {
            role: "scout",
            system: "You are concise.",
            prompt: "summarize",
            model: "openai/gpt-5.3-codex",
            provider: "pi",
          },
        },
      }),
    );

    state = await runEffect(
      applyLifecycleTransition(state, {
        schemaVersion: 1,
        runId,
        sequence: 3,
        timestamp: "2026-02-23T20:00:02.000Z",
        type: "task:error",
        payload: {
          taskId,
          message: "agent failed",
        },
      }),
    );

    const failure = await runEffect(
      Effect.flip(
        applyLifecycleTransition(state, {
          schemaVersion: 1,
          runId,
          sequence: 4,
          timestamp: "2026-02-23T20:00:03.000Z",
          type: "task:cancelled",
          payload: {
            taskId,
          },
        }),
      ),
    );

    expect(failure).toMatchObject({
      _tag: "LifecycleInvariantError",
      runId,
    });
  });
});
