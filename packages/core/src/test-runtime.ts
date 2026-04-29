import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect } from "effect";

export const runWithRuntime = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);

export const runWithBunServices = <A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, BunServices.layer));
