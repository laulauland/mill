import { Effect } from "effect";
import type { DriverCodec, DriverProcessConfig, DriverRegistration } from "@mill/core";

const PI_MODELS: ReadonlyArray<string> = ["openai/gpt-5.3-codex", "anthropic/claude-sonnet-4-6"];

export const createPiCodec = (): DriverCodec => ({
  modelCatalog: Effect.succeed(PI_MODELS),
});

export const createPiDriverConfig = (): DriverProcessConfig => ({
  command: "pi",
  args: ["-p"],
  env: {},
});

export const createPiDriverRegistration = (): DriverRegistration => ({
  description: "Local process driver",
  modelFormat: "provider/model-id",
  process: createPiDriverConfig(),
  codec: createPiCodec(),
});
