import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkExportBoundaries,
  collectWorkspacePackageJsonPaths,
  isInternalExportPath,
} from "./check-exports";

describe("check-exports", () => {
  it("collects package.json files for all workspace globs", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "mill-check-exports-workspaces-"));

    try {
      await writeFile(
        join(workspaceRoot, "package.json"),
        JSON.stringify(
          {
            name: "mill-fixture",
            private: true,
            workspaces: ["packages/*", "tools/*"],
          },
          null,
          2,
        ),
        "utf-8",
      );

      await mkdir(join(workspaceRoot, "packages", "core"), { recursive: true });
      await mkdir(join(workspaceRoot, "tools", "kit"), { recursive: true });

      await writeFile(
        join(workspaceRoot, "packages", "core", "package.json"),
        JSON.stringify(
          { name: "@fixture/core", exports: { ".": "./src/public/index.api.ts" } },
          null,
          2,
        ),
        "utf-8",
      );
      await writeFile(
        join(workspaceRoot, "tools", "kit", "package.json"),
        JSON.stringify(
          { name: "@fixture/kit", exports: { ".": "./src/public/index.api.ts" } },
          null,
          2,
        ),
        "utf-8",
      );

      const packageJsonPaths = await collectWorkspacePackageJsonPaths(workspaceRoot);
      const relativePaths = packageJsonPaths
        .map((path) => path.replace(`${workspaceRoot}/`, ""))
        .sort();

      expect(relativePaths).toEqual(["packages/core/package.json", "tools/kit/package.json"]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("flags exports that expose internal/runtime/domain paths", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "mill-check-exports-invalid-"));

    try {
      await writeFile(
        join(workspaceRoot, "package.json"),
        JSON.stringify(
          { name: "mill-fixture", private: true, workspaces: ["packages/*"] },
          null,
          2,
        ),
        "utf-8",
      );
      await mkdir(join(workspaceRoot, "packages", "core"), { recursive: true });

      await writeFile(
        join(workspaceRoot, "packages", "core", "package.json"),
        JSON.stringify(
          {
            name: "@fixture/core",
            exports: {
              ".": "./src/public/index.api.ts",
              "./bad": {
                import: "./dist/internal/runtime.js",
                default: ["./dist/domain/model.js", "./dist/public/index.js"],
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = await checkExportBoundaries(workspaceRoot);
      expect(result.packageCount).toBe(1);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.packageName).toBe("@fixture/core");
      expect(result.violations[0]?.invalidExports).toEqual([
        "./dist/domain/model.js",
        "./dist/internal/runtime.js",
      ]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("flags exports with internal/runtime/domain subpath keys", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "mill-check-exports-invalid-keys-"));

    try {
      await writeFile(
        join(workspaceRoot, "package.json"),
        JSON.stringify(
          { name: "mill-fixture", private: true, workspaces: ["packages/*"] },
          null,
          2,
        ),
        "utf-8",
      );
      await mkdir(join(workspaceRoot, "packages", "core"), { recursive: true });

      await writeFile(
        join(workspaceRoot, "packages", "core", "package.json"),
        JSON.stringify(
          {
            name: "@fixture/core",
            exports: {
              ".": "./src/public/index.api.ts",
              "./internal": "./dist/public/re-export.js",
              "./runtime/worker": {
                import: "./dist/public/runtime-worker.js",
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = await checkExportBoundaries(workspaceRoot);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.invalidExports).toEqual(["./internal", "./runtime/worker"]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("recognizes internal export paths", () => {
    expect(isInternalExportPath("./src/public/index.api.ts")).toBe(false);
    expect(isInternalExportPath("./src/internal/engine.effect.ts")).toBe(true);
    expect(isInternalExportPath("./dist/domain/run.schema.js")).toBe(true);
    expect(isInternalExportPath("./dist/runtime/worker.effect.js")).toBe(true);
  });
});
