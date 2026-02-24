import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { createDiscoveryPayload } from "./discovery.api";
import type { MillConfig } from "./types";

const makeDefaults = (): MillConfig => ({
  defaultDriver: "default",
  defaultExecutor: "direct",
  defaultModel: "openai/gpt-5.3-codex",
  drivers: {
    default: {
      description: "Catalog-backed test driver",
      modelFormat: "provider/model-id",
      process: {
        command: "pi",
        args: ["-p"],
        env: {},
      },
      codec: {
        modelCatalog: Effect.succeed(["provider/model-a", "provider/model-b"]),
      },
    },
    codex: {
      description: "Codex adapter",
      modelFormat: "provider/model-id",
      process: {
        command: "codex",
        args: [],
        env: {},
      },
      codec: {
        modelCatalog: Effect.succeed(["openai/gpt-5.3-codex"]),
      },
    },
  },
  executors: {
    direct: {
      description: "direct",
      runtime: {
        name: "direct",
        runProgram: (input) => input.execute,
      },
    },
    vm: {
      description: "vm",
      runtime: {
        name: "vm",
        runProgram: (input) => input.execute,
      },
    },
  },
  extensions: [],
  authoring: {
    instructions: "from-defaults",
  },
});

describe("createDiscoveryPayload", () => {
  it("returns discovery contract v1 with required SPEC §7 fields", async () => {
    const payload = await createDiscoveryPayload({
      defaults: makeDefaults(),
      cwd: "/repo",
      homeDirectory: "/home/tester",
      pathExists: async () => false,
    });

    expect(payload.discoveryVersion).toBe(1);
    expect(payload.programApi.spawnRequired).toEqual(["agent", "systemPrompt", "prompt"]);
    expect(payload.programApi.spawnOptional).toEqual(["model"]);
    expect(payload.programApi.resultFields).toEqual([
      "text",
      "sessionRef",
      "agent",
      "model",
      "driver",
      "exitCode",
      "stopReason",
    ]);
    expect(payload.authoring.instructions).toBe("from-defaults");
    expect(payload.executors.direct?.description).toBe("direct");
    expect(payload.executors.vm?.description).toBe("vm");
    expect(payload.async).toEqual({
      submit: "mill run <program.ts> --json",
      status: "mill status <runId> --json",
      wait: "mill wait <runId> --timeout 30 --json",
    });
  });

  it("sources driver models from the driver codec catalog", async () => {
    const payload = await createDiscoveryPayload({
      defaults: makeDefaults(),
      cwd: "/repo",
      homeDirectory: "/home/tester",
      pathExists: async () => false,
    });

    expect(payload.drivers.default?.models).toEqual(["provider/model-a", "provider/model-b"]);
    expect(payload.drivers.codex?.models).toEqual(["openai/gpt-5.3-codex"]);
  });

  it("applies authoring instructions from resolved config module", async () => {
    const payload = await createDiscoveryPayload({
      defaults: makeDefaults(),
      cwd: "/repo",
      homeDirectory: "/home/tester",
      pathExists: async (path) => path === "/repo/mill.config.ts",
      loadConfigModule: async () => ({
        default: {
          authoring: {
            instructions: "from-cwd-config",
          },
        },
      }),
    });

    expect(payload.authoring.instructions).toBe("from-cwd-config");
  });
});
