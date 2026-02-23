import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { runWithRuntime } from "../public/test-runtime.api";
import type { DriverRegistration } from "../public/types";
import { makeDriverRegistry } from "./driver-registry.effect";

const makeDriver = (name: string): DriverRegistration => ({
  description: `${name} driver`,
  modelFormat: "provider/model-id",
  process: {
    command: name,
    args: [],
    env: {},
  },
  codec: {
    modelCatalog: Effect.succeed([`${name}/model`]),
  },
  runtime: {
    name,
    spawn: () =>
      Effect.succeed({
        events: [],
        result: {
          text: `${name}:ok`,
          sessionRef: `session/${name}`,
          agent: "scout",
          model: `${name}/model`,
          driver: name,
          exitCode: 0,
        },
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
