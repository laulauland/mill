import { Data, Effect } from "effect";
import type { DriverRegistration, DriverRuntime } from "../public/types";

export class DriverRegistryError extends Data.TaggedError("DriverRegistryError")<{
  requested: string;
  available: ReadonlyArray<string>;
  message: string;
}> {}

export interface DriverRegistry {
  readonly list: ReadonlyArray<string>;
  readonly resolve: (name: string | undefined) => Effect.Effect<
    {
      readonly name: string;
      readonly registration: DriverRegistration;
      readonly runtime: DriverRuntime;
    },
    DriverRegistryError
  >;
}

export interface MakeDriverRegistryInput {
  readonly defaultDriver: string;
  readonly drivers: Readonly<Record<string, DriverRegistration>>;
}

const sortedDriverNames = (
  drivers: Readonly<Record<string, DriverRegistration>>,
): ReadonlyArray<string> => Object.keys(drivers).sort((left, right) => left.localeCompare(right));

const missingDriverError = (
  requested: string,
  available: ReadonlyArray<string>,
): DriverRegistryError =>
  new DriverRegistryError({
    requested,
    available,
    message: `Unknown driver '${requested}'. Available drivers: ${available.join(", ")}.`,
  });

const missingRuntimeError = (
  requested: string,
  available: ReadonlyArray<string>,
): DriverRegistryError =>
  new DriverRegistryError({
    requested,
    available,
    message: `Driver '${requested}' has no runtime adapter configured.`,
  });

export const makeDriverRegistry = (input: MakeDriverRegistryInput): DriverRegistry => {
  const available = sortedDriverNames(input.drivers);

  return {
    list: available,
    resolve: (name) => {
      const requested = name ?? input.defaultDriver;
      const registration = input.drivers[requested];

      if (registration === undefined) {
        return Effect.fail(missingDriverError(requested, available));
      }

      if (registration.runtime === undefined) {
        return Effect.fail(missingRuntimeError(requested, available));
      }

      return Effect.succeed({
        name: requested,
        registration,
        runtime: registration.runtime,
      });
    },
  };
};
