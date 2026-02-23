import { Runtime, type Effect } from "effect";

const runtime = Runtime.defaultRuntime;

export const runWithRuntime = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Runtime.runPromise(runtime)(effect);
