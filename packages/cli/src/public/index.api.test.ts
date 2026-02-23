import { describe, expect, it } from "bun:test";
import * as Schema from "@effect/schema/Schema";
import { runCli } from "./index.api";

const DiscoveryEnvelope = Schema.parseJson(
  Schema.Struct({
    discoveryVersion: Schema.Number,
    programApi: Schema.Struct({
      spawnRequired: Schema.Array(Schema.String),
      spawnOptional: Schema.Array(Schema.String),
      resultFields: Schema.Array(Schema.String),
    }),
    drivers: Schema.Record({
      key: Schema.String,
      value: Schema.Struct({
        description: Schema.String,
        modelFormat: Schema.String,
        models: Schema.Array(Schema.String),
      }),
    }),
    authoring: Schema.Struct({
      instructions: Schema.String,
    }),
    async: Schema.Struct({
      submit: Schema.String,
      status: Schema.String,
      wait: Schema.String,
    }),
  }),
);

describe("runCli", () => {
  it("writes machine payload to stdout only in --json mode", async () => {
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];

    const code = await runCli(["--help", "--json"], {
      cwd: "/workspace/repo",
      homeDirectory: "/Users/tester",
      pathExists: async () => false,
      io: {
        stdout: (line) => {
          stdout.push(line);
        },
        stderr: (line) => {
          stderr.push(line);
        },
      },
    });

    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stderr).toHaveLength(0);

    const payload = Schema.decodeUnknownSync(DiscoveryEnvelope)(stdout[0]);
    expect(payload.discoveryVersion).toBe(1);
    expect(payload.drivers.default?.models).toEqual([
      "openai/gpt-5.3-codex",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(payload.programApi.spawnRequired).toEqual(["agent", "systemPrompt", "prompt"]);
  });

  it("routes human help text to stdout in non-json mode", async () => {
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];

    const code = await runCli(["--help"], {
      cwd: "/workspace/repo",
      homeDirectory: "/Users/tester",
      pathExists: async () => false,
      io: {
        stdout: (line) => {
          stdout.push(line);
        },
        stderr: (line) => {
          stderr.push(line);
        },
      },
    });

    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stderr).toHaveLength(0);
    expect(stdout[0]).toContain("mill — Effect-first orchestration runtime");
  });
});
