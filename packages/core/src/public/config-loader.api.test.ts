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
      loadConfigOverrides: async (path) => ({
        authoringInstructions: `loaded:${path}`,
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
      loadConfigOverrides: async (path) => ({
        authoringInstructions: `loaded:${path}`,
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
      loadConfigOverrides: async (path) => ({
        authoringInstructions: `loaded:${path}`,
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
      loadConfigOverrides: async (path) => ({
        authoringInstructions: `loaded:${path}`,
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
      loadConfigOverrides: async (path) => ({
        authoringInstructions: `loaded:${path}`,
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
      loadConfigOverrides: async (path) => ({
        authoringInstructions: `loaded:${path}`,
      }),
    });

    expect(resolved.source).toBe("home");
    expect(resolved.configPath).toBe("/Users/tester/.mill/config.ts");
    expect(resolved.config.authoring.instructions).toBe("loaded:/Users/tester/.mill/config.ts");
  });

  it("loads computed overrides from mill.config.ts const expressions", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "mill-config-loader-"));
    const configPath = join(tempDirectory, "mill.config.ts");

    await writeFile(
      configPath,
      [
        'const instructions = [`Use systemPrompt for WHO.`, `Use prompt for WHAT.`].join(" ");',
        "export default {",
        '  defaultDriver: "pi-local" as const,',
        '  defaultExecutor: "vm" as const,',
        '  defaultModel: "openai/gpt-5.3-codex" as const,',
        "  authoring: {",
        "    instructions,",
        "  },",
        "};",
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
      expect(resolved.config.defaultDriver).toBe("pi-local");
      expect(resolved.config.defaultExecutor).toBe("vm");
      expect(resolved.config.defaultModel).toBe("openai/gpt-5.3-codex");
      expect(resolved.config.authoring.instructions).toBe(
        "Use systemPrompt for WHO. Use prompt for WHAT.",
      );
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
