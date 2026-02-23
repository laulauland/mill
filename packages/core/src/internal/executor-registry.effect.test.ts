import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { runWithRuntime } from "../public/test-runtime.api";
import type { ExecutorRegistration } from "../public/types";
import { makeExecutorRegistry } from "./executor-registry.effect";

const makeExecutor = (name: string): ExecutorRegistration => ({
  description: `${name} executor`,
  runtime: {
    name,
    runProgram: (input) =>
      Effect.zipRight(
        Effect.sync(() => {
          (globalThis as { __millExecutorName?: string }).__millExecutorName = name;
        }),
        input.execute,
      ),
  },
});

describe("makeExecutorRegistry", () => {
  it("resolves configured default executor when no override is provided", async () => {
    const registry = makeExecutorRegistry({
      defaultExecutor: "direct",
      executors: {
        direct: makeExecutor("direct"),
        vm: makeExecutor("vm"),
      },
    });

    const selected = await runWithRuntime(registry.resolve(undefined));

    expect(selected.name).toBe("direct");
    expect(selected.registration.description).toBe("direct executor");
  });

  it("resolves explicit override executor when available", async () => {
    const registry = makeExecutorRegistry({
      defaultExecutor: "direct",
      executors: {
        direct: makeExecutor("direct"),
        vm: makeExecutor("vm"),
      },
    });

    const selected = await runWithRuntime(registry.resolve("vm"));

    expect(selected.name).toBe("vm");
    expect(selected.registration.description).toBe("vm executor");
  });

  it("fails with a typed registry error for unknown executors", async () => {
    const registry = makeExecutorRegistry({
      defaultExecutor: "direct",
      executors: {
        direct: makeExecutor("direct"),
      },
    });

    const selectionError = await runWithRuntime(Effect.flip(registry.resolve("missing")));

    expect(selectionError).toMatchObject({
      _tag: "ExecutorRegistryError",
      requested: "missing",
      available: ["direct"],
    });
  });
});
