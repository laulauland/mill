import * as Command from "@effect/platform/Command";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect } from "effect";
import type { DriverCodec, DriverProcessConfig, DriverRegistration } from "@mill/core";
import { decodePiModelCatalogOutput } from "../pi.codec";
import { makePiProcessDriver } from "../process-driver.effect";

export interface CreatePiDriverRegistrationInput {
  readonly process?: DriverProcessConfig;
  readonly models?: ReadonlyArray<string>;
}

const defaultModelCatalog = (
  process: DriverProcessConfig,
): Effect.Effect<ReadonlyArray<string>, never> => {
  if (process.command !== "pi") {
    return Effect.succeed([]);
  }

  const listModelsEffect = Effect.provide(
    Command.string(Command.make(process.command, "--list-models")),
    BunContext.layer,
  );

  return Effect.catchAll(
    Effect.flatMap(listModelsEffect, decodePiModelCatalogOutput),
    () => Effect.succeed([]),
  );
};

export const createPiCodec = (input?: {
  readonly process?: DriverProcessConfig;
  readonly models?: ReadonlyArray<string>;
}): DriverCodec => {
  if (input?.models !== undefined) {
    return {
      modelCatalog: Effect.succeed(input.models),
    };
  }

  const process = input?.process ?? createPiDriverConfig();

  return {
    modelCatalog: defaultModelCatalog(process),
  };
};

export const createPiDriverConfig = (): DriverProcessConfig => ({
  command: "pi",
  args: [
    "--mode",
    "json",
    "--print",
    "--no-session",
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
