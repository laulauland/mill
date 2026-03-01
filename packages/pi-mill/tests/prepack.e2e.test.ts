import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import * as path from "node:path";

const packageDir = path.resolve("packages/pi-mill");

function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): { stdout: string; stderr: string } {
  const result = spawnSync(command, [...args], {
    cwd: options?.cwd,
    env: options?.env,
    encoding: "utf-8",
    stdio: "pipe",
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed with exit code ${String(result.status)}`,
        stdout,
        stderr,
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    );
  }

  return { stdout, stderr };
}

describe("pi-mill prepack (e2e)", () => {
  it("vendors bundled mill CLI during bun pack dry-run", async () => {
    const bundledCli = path.join(packageDir, ".vendor", "mill.mjs");

    try {
      const packed = runCommand("bun", ["pm", "pack", "--dry-run"], {
        cwd: packageDir,
      });
      const packOutput = `${packed.stdout}\n${packed.stderr}`;

      expect(packOutput).toContain(".vendor/mill.mjs");
      expect(packOutput).toContain(".pi-skills/mill/SKILL.md");

      const help = runCommand(process.execPath, [bundledCli, "--help"], {
        cwd: packageDir,
        env: {
          ...process.env,
          MILL_RUN_DEPTH: "",
        },
      });
      const helpOutput = `${help.stdout}\n${help.stderr}`;

      expect(helpOutput).toContain("Usage: mill <command>");
      expect(helpOutput).toContain("run <program.ts>");
    } finally {
      await Promise.all([
        rm(path.join(packageDir, ".vendor"), { recursive: true, force: true }),
        rm(path.join(packageDir, ".pi-skills"), { recursive: true, force: true }),
      ]);
    }
  });
});
