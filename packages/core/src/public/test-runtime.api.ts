import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime } from "effect";

const runtime = Runtime.defaultRuntime;

export const runWithRuntime = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Runtime.runPromise(runtime)(effect);

export const runWithBunContext = <A, E>(
  effect: Effect.Effect<A, E, BunContext.BunContext>,
): Promise<A> => Runtime.runPromise(runtime)(Effect.provide(effect, BunContext.layer));
