import { Effect } from "effect";
import type { DriverCodec, DriverProcessConfig, DriverRegistration } from "@mill/core";
import { makePiProcessDriver } from "../process-driver.effect";

export interface CreatePiDriverRegistrationInput {
  readonly process?: DriverProcessConfig;
  readonly models?: ReadonlyArray<string>;
}

export const createPiCodec = (input?: {
  readonly process?: DriverProcessConfig;
  readonly models?: ReadonlyArray<string>;
}): DriverCodec => {
  if (input?.models !== undefined) {
    return {
      modelCatalog: Effect.succeed(input.models),
    };
  }

  return {
    modelCatalog: Effect.succeed([]),
  };
};

export const createPiDriverConfig = (): DriverProcessConfig => ({
  command: "pi",
  args: [
    "--mode",
    "json",
    "--print",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
  ],
  env: undefined,
});

export const createPiDriverRegistration = (
  input?: CreatePiDriverRegistrationInput,
): DriverRegistration => {
  const process = input?.process ?? createPiDriverConfig();

  return {
    description: "PI process driver",
    modelFormat: "provider/model-id",
    process,
    codec: createPiCodec({
      process,
      models: input?.models,
    }),
    runtime: makePiProcessDriver(process),
  };
};
