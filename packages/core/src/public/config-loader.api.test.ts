import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveConfig } from "./config-loader.api";
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
        modelCatalog: Effect.succeed(["provider/model-a"]),
      },
    },
  },
  executors: {
    direct: {
      description: "Direct test executor",
      runtime: {
        name: "direct",
        runProgram: (input) => input.execute,
      },
    },
    vm: {
      description: "VM test executor",
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

describe("resolveConfig", () => {
  it("prefers ./mill.config.ts from cwd", async () => {
    const resolved = await resolveConfig({
      defaults: makeDefaults(),
      cwd: "/workspace/repo/app",
      homeDirectory: "/Users/tester",
      pathExists: async (path) => path === "/workspace/repo/app/mill.config.ts",
      loadConfigModule: async (path) => ({
        default: {
          authoring: {
            instructions: `loaded:${path}`,
          },
        },
      }),
    });

    expect(resolved.source).toBe("cwd");
    expect(resolved.configPath).toBe("/workspace/repo/app/mill.config.ts");
    expect(resolved.config.authoring.instructions).toBe(
      "loaded:/workspace/repo/app/mill.config.ts",
    );
  });

  it("walks upward to repo root when cwd config is missing", async () => {
    const resolved = await resolveConfig({
      defaults: makeDefaults(),
      cwd: "/workspace/repo/packages/cli",
      homeDirectory: "/Users/tester",
      pathExists: async (path) =>
        path === "/workspace/repo/.jj" || path === "/workspace/repo/mill.config.ts",
      loadConfigModule: async (path) => ({
        default: {
          authoring: {
            instructions: `loaded:${path}`,
          },
        },
      }),
    });

    expect(resolved.source).toBe("upward");
    expect(resolved.configPath).toBe("/workspace/repo/mill.config.ts");
    expect(resolved.config.authoring.instructions).toBe("loaded:/workspace/repo/mill.config.ts");
  });

  it("uses ~/.mill/config.ts when no project config is found", async () => {
    const resolved = await resolveConfig({
      defaults: makeDefaults(),
      cwd: "/workspace/repo/packages/cli",
      homeDirectory: "/Users/tester",
      pathExists: async (path) => path === "/Users/tester/.mill/config.ts",
      loadConfigModule: async (path) => ({
        default: {
          authoring: {
            instructions: `loaded:${path}`,
          },
        },
      }),
    });

    expect(resolved.source).toBe("home");
    expect(resolved.configPath).toBe("/Users/tester/.mill/config.ts");
    expect(resolved.config.authoring.instructions).toBe("loaded:/Users/tester/.mill/config.ts");
  });

  it("falls back to internal defaults", async () => {
    const resolved = await resolveConfig({
      defaults: makeDefaults(),
      cwd: "/workspace/repo/packages/cli",
      homeDirectory: "/Users/tester",
      pathExists: async () => false,
    });

    expect(resolved.source).toBe("defaults");
    expect(resolved.configPath).toBeUndefined();
    expect(resolved.config.authoring.instructions).toBe("from-defaults");
  });

  it("stops upward search at repo root", async () => {
    const resolved = await resolveConfig({
      defaults: makeDefaults(),
      cwd: "/workspace/repo/packages/cli",
      homeDirectory: "/Users/tester",
      pathExists: async (path) =>
        path === "/workspace/repo/.jj" ||
        path === "/workspace/mill.config.ts" ||
        path === "/Users/tester/.mill/config.ts",
      loadConfigModule: async (path) => ({
        default: {
          authoring: {
            instructions: `loaded:${path}`,
          },
        },
      }),
    });

    expect(resolved.source).toBe("home");
    expect(resolved.configPath).toBe("/Users/tester/.mill/config.ts");
    expect(resolved.config.authoring.instructions).toBe("loaded:/Users/tester/.mill/config.ts");
  });

  it("does not search above repo root when cwd is repo root", async () => {
    const resolved = await resolveConfig({
      defaults: makeDefaults(),
      cwd: "/workspace/repo",
      homeDirectory: "/Users/tester",
      pathExists: async (path) =>
        path === "/workspace/repo/.jj" ||
        path === "/workspace/mill.config.ts" ||
        path === "/Users/tester/.mill/config.ts",
      loadConfigModule: async (path) => ({
        default: {
          authoring: {
            instructions: `loaded:${path}`,
          },
        },
      }),
    });

    expect(resolved.source).toBe("home");
    expect(resolved.configPath).toBe("/Users/tester/.mill/config.ts");
  });

  it("skips upward config lookup when cwd is outside a repo", async () => {
    const resolved = await resolveConfig({
      defaults: makeDefaults(),
      cwd: "/scratch/playground/app",
      homeDirectory: "/Users/tester",
      pathExists: async (path) =>
        path === "/scratch/mill.config.ts" || path === "/Users/tester/.mill/config.ts",
      loadConfigModule: async (path) => ({
        default: {
          authoring: {
            instructions: `loaded:${path}`,
          },
        },
      }),
    });

    expect(resolved.source).toBe("home");
    expect(resolved.configPath).toBe("/Users/tester/.mill/config.ts");
    expect(resolved.config.authoring.instructions).toBe("loaded:/Users/tester/.mill/config.ts");
  });

  it("loads real TS module exports (drivers/executors/extensions) from mill.config.ts", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-config-loader-"));
    const configPath = join(tempDirectory, "mill.config.ts");
    const configLoaderPath = decodeURIComponent(
      new URL("./config-loader.api.ts", import.meta.url).pathname,
    );

    await writeFile(
      configPath,
      [
        `import { defineConfig, processDriver } from ${JSON.stringify(configLoaderPath)};`,
        "",
        'const suffix = ["from", "module"].join("-");',
        "const extensionPrefix = `extension-${suffix}`;",
        "",
        "export default defineConfig({",
        '  defaultDriver: "module-driver",',
        '  defaultExecutor: "module-executor",',
        '  defaultModel: "provider/module-model",',
        "  maxRunDepth: 3,",
        "  drivers: {",
        "    'module-driver': processDriver({",
        "      description: `driver-${suffix}`,",
        '      modelFormat: "provider/model-id",',
        "      process: {",
        '        command: "module-driver",',
        "        args: [],",
        "        env: {},",
        "      },",
        "      codec: {",
        '        modelCatalog: { _tag: "loaded-from-module" },',
        "      },",
        "      runtime: {",
        '        name: "module-driver",',
        "        spawn: () => ({ kind: " + '"driver-runtime"' + " }),",
        "      },",
        "    }),",
        "  },",
        "  executors: {",
        "    'module-executor': {",
        '      description: "executor-from-module",',
        "      runtime: {",
        '        name: "module-executor",',
        "        runProgram: ({ execute }) => execute,",
        "      },",
        "    },",
        "  },",
        "  extensions: [",
        "    {",
        '      name: "moduleTools",',
        "      api: {",
        "        echo: (...args) => `${extensionPrefix}:${String(args[0] ?? " + '""' + ")}`,",
        "      },",
        "    },",
        "  ],",
        "  authoring: {",
        '    instructions: ["Use", "module", "config"].join(" "),',
        "  },",
        "});",
      ].join("\n"),
      "utf-8",
    );

    try {
      const resolved = await resolveConfig({
        defaults: makeDefaults(),
        cwd: tempDirectory,
        homeDirectory: join(tempDirectory, "missing-home"),
      });

      expect(resolved.source).toBe("cwd");
      expect(resolved.configPath).toBe(configPath);
      expect(resolved.config.defaultDriver).toBe("module-driver");
      expect(resolved.config.defaultExecutor).toBe("module-executor");
      expect(resolved.config.defaultModel).toBe("provider/module-model");
      expect(resolved.config.maxRunDepth).toBe(3);
      expect(resolved.config.authoring.instructions).toBe("Use module config");
      expect(Object.keys(resolved.config.drivers)).toContain("default");
      expect(Object.keys(resolved.config.drivers)).toContain("module-driver");
      expect(Object.keys(resolved.config.executors)).toContain("direct");
      expect(Object.keys(resolved.config.executors)).toContain("module-executor");
      expect(resolved.config.extensions[0]?.name).toBe("moduleTools");
      expect(typeof resolved.config.drivers["module-driver"]?.runtime?.spawn).toBe("function");
      expect(typeof resolved.config.executors["module-executor"]?.runtime.runProgram).toBe(
        "function",
      );
      expect(typeof resolved.config.extensions[0]?.api?.echo).toBe("function");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
