import { Context, Data, Effect, Layer, Ref } from "effect";
import { TaskEntity, makeTaskEntity } from "./TaskEntity";
import { IdGenerator } from "./IdGenerator";
import { EventAppender } from "./EventAppender";

export class EntityRegistryError extends Data.TaggedError("EntityRegistryError")<{
  readonly taskId: string;
  readonly message: string;
}> {}

export interface EntityRegistry {
  readonly getOrCreate: (
    taskId: string,
    rootTaskId: string,
    parentId?: string,
  ) => Effect.Effect<TaskEntity, never>;
  readonly lookup: (taskId: string) => Effect.Effect<TaskEntity | undefined, never>;
  readonly register: (entity: TaskEntity) => Effect.Effect<void, never>;
  readonly remove: (taskId: string) => Effect.Effect<void, never>;
  readonly list: () => Effect.Effect<ReadonlyArray<string>, never>;
}

export const makeEntityRegistry = Effect.gen(function* () {
  const registryRef = yield* Ref.make(new Map<string, TaskEntity>());
  const eventAppender = yield* EventAppender;
  const idGenerator = yield* IdGenerator;

  const getOrCreate = (
    taskId: string,
    rootTaskId: string,
    parentId?: string,
  ): Effect.Effect<TaskEntity, never> =>
    Effect.gen(function* () {
      const registry = yield* Ref.get(registryRef);
      const existing = registry.get(taskId);
      if (existing !== undefined) {
        return existing;
      }
      const entity = yield* makeTaskEntity({ taskId, rootTaskId, parentId });
      yield* Ref.update(registryRef, (map) => {
        const next = new Map(map);
        next.set(taskId, entity);
        return next;
      });
      return entity;
    }).pipe(
      Effect.provide(Layer.succeed(EventAppender, eventAppender)),
      Effect.provide(Layer.succeed(IdGenerator, idGenerator)),
    );

  const lookup = (taskId: string): Effect.Effect<TaskEntity | undefined, never> =>
    Ref.get(registryRef).pipe(Effect.map((map) => map.get(taskId)));

  const register = (entity: TaskEntity): Effect.Effect<void, never> =>
    Ref.update(registryRef, (map) => {
      const next = new Map(map);
      next.set(entity.taskId, entity);
      return next;
    });

  const remove = (taskId: string): Effect.Effect<void, never> =>
    Ref.update(registryRef, (map) => {
      const next = new Map(map);
      next.delete(taskId);
      return next;
    });

  const list = (): Effect.Effect<ReadonlyArray<string>, never> =>
    Ref.get(registryRef).pipe(Effect.map((map) => Array.from(map.keys())));

  return {
    getOrCreate,
    lookup,
    register,
    remove,
    list,
  } satisfies EntityRegistry;
});

export const EntityRegistry = Context.Service<EntityRegistry>("@mill/core/EntityRegistry");

export const EntityRegistryLive = Layer.effect(EntityRegistry, makeEntityRegistry);
