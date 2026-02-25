import { Effect, Runtime } from "effect";
import type { DiscoveryPayload, DriverRegistration, ResolveConfigOptions } from "./types";
import { resolveConfig } from "./config-loader.api";

const runtime = Runtime.defaultRuntime;

const buildDiscoveryDrivers = (
  drivers: Readonly<Record<string, DriverRegistration>>,
): Effect.Effect<DiscoveryPayload["drivers"]> =>
  Effect.map(
    Effect.forEach(Object.entries(drivers), ([driverName, registration]) =>
      Effect.map(
        registration.codec.modelCatalog,
        (models) =>
          [
            driverName,
            {
              description: registration.description,
              modelFormat: registration.modelFormat,
              models,
            },
          ] as const,
      ),
    ),
    (entries) => Object.fromEntries(entries),
  );

const buildDiscoveryExecutors = (
  executors: ResolveConfigOptions["defaults"]["executors"],
): DiscoveryPayload["executors"] =>
  Object.fromEntries(
    Object.entries(executors).map(([executorName, registration]) => [
      executorName,
      {
        description: registration.description,
      },
    ]),
  );

export const createDiscoveryPayload = async (
  options: ResolveConfigOptions,
): Promise<DiscoveryPayload> => {
  const resolvedConfig = await resolveConfig(options);

  const drivers = await Runtime.runPromise(runtime)(
    buildDiscoveryDrivers(resolvedConfig.config.drivers),
  );
  const executors = buildDiscoveryExecutors(resolvedConfig.config.executors);

  return {
    discoveryVersion: 1,
    programApi: {
      spawnRequired: ["agent", "systemPrompt", "prompt"],
      spawnOptional: ["model"],
      resultFields: ["text", "sessionRef", "agent", "model", "driver", "exitCode", "stopReason"],
    },
    drivers,
    executors,
    authoring: {
      instructions: resolvedConfig.config.authoring.instructions,
    },
    async: {
      submit: "mill run <program.ts> --json",
      status: "mill status <runId> --json",
      wait: "mill wait <runId> --timeout 30 --json",
      watch: "mill watch [--run <runId>] [--since-time <ISO-8601>] --json",
    },
  };
};
