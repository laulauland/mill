import { Context, Effect, Layer } from "effect";

export interface PathService {
  readonly tasksDirectory: Effect.Effect<string>;
}

export const PathService = Context.Service<PathService>("@mill/core/PathService");

export const PathServiceLive = (tasksDirectory: string): Layer.Layer<PathService> =>
  Layer.succeed(PathService, {
    tasksDirectory: Effect.succeed(tasksDirectory),
  });
