import * as fs from "node:fs";
import * as path from "node:path";
import { Effect } from "effect";
import type { DriverCodec, DriverProcessConfig, DriverRegistration } from "@mill/core";
import { makePiProcessDriver } from "../process-driver.effect";

export interface CreatePiDriverRegistrationInput {
  readonly process?: DriverProcessConfig;
  readonly models?: ReadonlyArray<string>;
}

const normalizeModelCatalog = (models: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.from(new Set(models.map((model) => model.trim()).filter((model) => model.length > 0)));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readStringArrayField = (
  record: Record<string, unknown>,
  key: string,
): ReadonlyArray<string> | undefined => {
  const value = record[key];

  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is string => typeof entry === "string");
};

const readPiEnabledModels = (): ReadonlyArray<string> => {
  const home = process.env.HOME;

  if (home === undefined || home.length === 0) {
    return [];
  }

  const settingsPath = path.join(home, ".pi", "agent", "settings.json");

  if (!fs.existsSync(settingsPath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (!isRecord(parsed)) {
      return [];
    }

    return normalizeModelCatalog(readStringArrayField(parsed, "enabledModels") ?? []);
  } catch {
    return [];
  }
};

export const createPiCodec = (input?: {
  readonly process?: DriverProcessConfig;
  readonly models?: ReadonlyArray<string>;
}): DriverCodec => ({
  modelCatalog: Effect.succeed(normalizeModelCatalog(input?.models ?? readPiEnabledModels())),
});

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
