import { describe, expect, it } from "bun:test";
import * as Command from "@effect/platform/Command";
import * as Schema from "@effect/schema/Schema";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime } from "effect";

const runtime = Runtime.defaultRuntime;

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

describe("mill --help --json (e2e)", () => {
  it("returns discovery contract payload on stdout", async () => {
    const output = await Runtime.runPromise(runtime)(
      Effect.provide(
        Command.string(
          Command.make("bun", "run", "packages/cli/src/bin/mill.ts", "--help", "--json"),
        ),
        BunContext.layer,
      ),
    );

    const payload = Schema.decodeUnknownSync(DiscoveryEnvelope)(output);
    expect(payload.discoveryVersion).toBe(1);
    expect(payload.programApi.spawnRequired).toEqual(["agent", "systemPrompt", "prompt"]);
    expect(payload.drivers.default?.models).toEqual([
      "openai/gpt-5.3-codex",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(payload.authoring.instructions.length).toBeGreaterThan(0);
    expect(payload.async.submit).toBe("mill run <program.ts> --json");
  });
});
