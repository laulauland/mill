import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, type Scope } from "effect";

export const runWithRuntime = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);

export const runWithBunServices = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(effect, BunServices.layer)));

export const runEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, BunServices.layer));
