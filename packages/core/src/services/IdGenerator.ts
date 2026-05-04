import { Context, Effect, Layer } from "effect";

export interface IdGenerator {
  readonly generateTaskId: Effect.Effect<string>;
}

let nextId = 0;

export const IdGenerator = Context.Service<IdGenerator>("@mill/core/IdGenerator");

export const IdGeneratorLive: Layer.Layer<IdGenerator> = Layer.succeed(IdGenerator, {
  generateTaskId: Effect.sync(() => {
    nextId += 1;
    return `task_${Date.now()}_${nextId}`;
  }),
});
