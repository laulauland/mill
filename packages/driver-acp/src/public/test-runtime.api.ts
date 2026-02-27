import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime, type Scope } from "effect";

const runtime = Runtime.defaultRuntime;

export const runWithRuntime = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Runtime.runPromise(runtime)(effect);

export const runWithBunContext = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope>,
): Promise<A> => Runtime.runPromise(runtime)(Effect.scoped(Effect.provide(effect, BunContext.layer)));

export const runEffect = <A, E>(
  effect: Effect.Effect<A, E>,
): Promise<A> => Runtime.runPromise(runtime)(Effect.provide(effect, BunContext.layer));
