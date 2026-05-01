import { describe, expect, it } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const makeCommand = (command: string, ...args: ReadonlyArray<string>): ChildProcess.Command =>
  ChildProcess.make(command, args);

const envCommand = (
  command: ChildProcess.Command,
  env: Readonly<Record<string, string | undefined>>,
): ChildProcess.Command => {
  if (!ChildProcess.isStandardCommand(command)) {
    return command;
  }

  return ChildProcess.make(command.command, command.args, {
    ...command.options,
    env: {
      ...command.options.env,
      ...env,
    },
    extendEnv: true,
  });
};

const withNeutralRunDepthEnv = (command: ChildProcess.Command): ChildProcess.Command =>
  envCommand(command, {
    MILL_RUN_DEPTH: "",
  });

const commandOutput = (command: ChildProcess.Command): Promise<string> =>
  Effect.runPromise(
    Effect.provide(
      ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
        spawner.string(withNeutralRunDepthEnv(command)),
      ),
      BunServices.layer,
    ),
  );

describe("mill help (e2e)", () => {
  it("prints top-level help via built-in --help", async () => {
    const output = await commandOutput(
      makeCommand("bun", "run", "packages/cli/src/mill.ts", "--help"),
    );

    expect(output).toContain("Usage: mill <command>");
    expect(output).toContain("Commands:");
    expect(output).toContain("run <program.ts>");
    expect(output).not.toContain("inspect <ref>");
    expect(output).not.toContain("Effect-first");
  });

  it("prints per-command help via built-in --help", async () => {
    const output = await commandOutput(
      makeCommand("bun", "run", "packages/cli/src/mill.ts", "run", "--help"),
    );

    expect(output).toContain("$ run [--json] [--sync]");
  });
});

describe("mill run/status/wait (e2e)", () => {});
