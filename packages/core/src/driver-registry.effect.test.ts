import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { runWithRuntime } from "./test-runtime";
import type { DriverRegistration } from "./types";
import { makeDriverRegistry } from "./driver-registry.effect";

const makeDriver = (name: string): DriverRegistration => ({
  description: `${name} driver`,
  modelFormat: "provider/model-id",
  process: {
    command: name,
    args: [],
    env: {},
  },
  models: Effect.succeed([`${name}/model`]),
  runtime: {
    name,
    createSession: (input) =>
      Effect.succeed({
        sessionRef: `session/${name}`,
        startTurn: () =>
          Effect.succeed({
            events: [],
            result: {
              text: `${name}:ok`,
              sessionRef: `session/${name}`,
              role: input.role,
              model: input.model,
              driver: name,
              exitCode: 0,
            },
          }),
        cancelTurn: () => Effect.void,
        close: () => Effect.void,
      }),
  },
});

describe("makeDriverRegistry", () => {
  it("resolves configured default driver when no override is provided", async () => {
    const registry = makeDriverRegistry({
      defaultDriver: "default",
      drivers: {
        default: makeDriver("pi"),
        codex: makeDriver("codex"),
      },
    });

    const selected = await runWithRuntime(registry.resolve(undefined));

    expect(selected.name).toBe("default");
    expect(selected.registration.description).toBe("pi driver");
  });

  it("resolves explicit override driver when available", async () => {
    const registry = makeDriverRegistry({
      defaultDriver: "default",
      drivers: {
        default: makeDriver("pi"),
        codex: makeDriver("codex"),
      },
    });

    const selected = await runWithRuntime(registry.resolve("codex"));

    expect(selected.name).toBe("codex");
    expect(selected.registration.description).toBe("codex driver");
  });

  it("fails with a typed registry error for unknown drivers", async () => {
    const registry = makeDriverRegistry({
      defaultDriver: "default",
      drivers: {
        default: makeDriver("pi"),
      },
    });

    const selectionError = await runWithRuntime(Effect.flip(registry.resolve("missing")));

    expect(selectionError).toMatchObject({
      _tag: "DriverRegistryError",
      requested: "missing",
      available: ["default"],
    });
  });
});
