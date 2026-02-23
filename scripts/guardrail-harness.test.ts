import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGuardrailCommand, runGuardrailSuite } from "./guardrail-harness";

const repositoryRoot = process.cwd();
const astGrepConfigPath = join(repositoryRoot, ".ast-grep", "sgconfig.yml");

describe("guardrail harness", () => {
  it("runs required guardrail checks from Bun tests", async () => {
    const result = await runGuardrailSuite({
      cwd: repositoryRoot,
      checks: [
        {
          name: "ast-grep-rule-tests",
          cmd: ["bun", "run", "lint:ast-grep:test"],
        },
        {
          name: "effect",
          cmd: ["bun", "run", "lint:effect"],
        },
        {
          name: "boundary",
          cmd: ["bun", "run", "lint:boundary"],
        },
        {
          name: "runtime-safety",
          cmd: ["bun", "run", "lint:runtime-safety"],
        },
        {
          name: "exports",
          cmd: ["bun", "run", "lint:exports"],
        },
      ],
    });

    expect(result.failures).toHaveLength(0);
  });

  it("fails boundary checks for public -> internal imports and Runtime.runPromise outside boundary", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "mill-guardrail-boundary-"));

    try {
      const badPublicPath = join(fixtureRoot, "packages", "core", "src", "public", "bad.ts");
      const badInternalPath = join(
        fixtureRoot,
        "packages",
        "core",
        "src",
        "internal",
        "bridge.effect.ts",
      );
      await mkdir(join(fixtureRoot, "packages", "core", "src", "public"), { recursive: true });
      await mkdir(join(fixtureRoot, "packages", "core", "src", "internal"), { recursive: true });

      await writeFile(
        badPublicPath,
        ['import { makeEngine } from "../internal/engine.effect";'].join("\n"),
        "utf-8",
      );
      await writeFile(
        badInternalPath,
        [
          "import * as Runtime from \"effect/Runtime\";",
          "const run = Runtime.runPromise(runtime)(effect);",
        ].join("\n"),
        "utf-8",
      );

      const commandResult = await runGuardrailCommand({
        cwd: fixtureRoot,
        cmd: [
          "ast-grep",
          "scan",
          "--config",
          astGrepConfigPath,
          "packages/core/src",
          "--error",
          "--filter",
          "no-(public-import-internal|runtime-runpromise-outside-boundary)",
        ],
      });

      expect(commandResult.exitCode).toBeGreaterThan(0);
      expect(commandResult.combinedOutput).toContain("no-public-import-internal");
      expect(commandResult.combinedOutput).toContain("no-runtime-runpromise-outside-boundary");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails runtime safety checks for shell/env/time/random/json violations", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "mill-guardrail-runtime-"));

    try {
      const badInternalPath = join(fixtureRoot, "packages", "core", "src", "internal", "bad.effect.ts");
      await mkdir(join(fixtureRoot, "packages", "core", "src", "internal"), { recursive: true });

      await writeFile(
        badInternalPath,
        [
          'import * as Command from "@effect/platform/Command";',
          'const payload = JSON.parse("{}") as Record<string, unknown>;',
          "const token = process.env.API_TOKEN;",
          "const now = Date.now();",
          "const random = Math.random();",
          'const cmd = Command.make("bash", "-lc", "echo unsafe");',
        ].join("\n"),
        "utf-8",
      );

      const commandResult = await runGuardrailCommand({
        cwd: fixtureRoot,
        cmd: [
          "ast-grep",
          "scan",
          "--config",
          astGrepConfigPath,
          "packages/core/src/internal",
          "--error",
          "--filter",
          "no-(json-parse-outside-codec|shell-string-command|process-env-outside-config|date-now-outside-clock|math-random-outside-random)",
        ],
      });

      expect(commandResult.exitCode).toBeGreaterThan(0);
      expect(commandResult.combinedOutput).toContain("no-json-parse-outside-codec");
      expect(commandResult.combinedOutput).toContain("no-shell-string-command");
      expect(commandResult.combinedOutput).toContain("no-process-env-outside-config");
      expect(commandResult.combinedOutput).toContain("no-date-now-outside-clock");
      expect(commandResult.combinedOutput).toContain("no-math-random-outside-random");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
