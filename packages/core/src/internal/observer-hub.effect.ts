import { Effect, PubSub, Stream } from "effect";
import type { MillEvent } from "../domain/event.schema";

const tier1PubSubByRun = new Map<string, PubSub.PubSub<MillEvent>>();
const rawPubSubByRun = new Map<string, PubSub.PubSub<string>>();
let tier1GlobalPubSub: PubSub.PubSub<MillEvent> | undefined;

const ensureTier1PubSub = (runId: string): Effect.Effect<PubSub.PubSub<MillEvent>> =>
  Effect.suspend(() => {
    const existing = tier1PubSubByRun.get(runId);

    if (existing !== undefined) {
      return Effect.succeed(existing);
    }

    return Effect.tap(PubSub.unbounded<MillEvent>(), (pubSub) =>
      Effect.sync(() => {
        tier1PubSubByRun.set(runId, pubSub);
      }),
    );
  });

const ensureRawPubSub = (runId: string): Effect.Effect<PubSub.PubSub<string>> =>
  Effect.suspend(() => {
    const existing = rawPubSubByRun.get(runId);

    if (existing !== undefined) {
      return Effect.succeed(existing);
    }

    return Effect.tap(PubSub.unbounded<string>(), (pubSub) =>
      Effect.sync(() => {
        rawPubSubByRun.set(runId, pubSub);
      }),
    );
  });

const ensureTier1GlobalPubSub = (): Effect.Effect<PubSub.PubSub<MillEvent>> =>
  Effect.suspend(() => {
    if (tier1GlobalPubSub !== undefined) {
      return Effect.succeed(tier1GlobalPubSub);
    }

    return Effect.tap(PubSub.unbounded<MillEvent>(), (pubSub) =>
      Effect.sync(() => {
        tier1GlobalPubSub = pubSub;
      }),
    );
  });

export const publishTier1Event = (runId: string, event: MillEvent): Effect.Effect<void> =>
  Effect.zipRight(
    Effect.asVoid(
      Effect.flatMap(ensureTier1PubSub(runId), (pubSub) => PubSub.publish(pubSub, event)),
    ),
    Effect.asVoid(
      Effect.flatMap(ensureTier1GlobalPubSub(), (pubSub) => PubSub.publish(pubSub, event)),
    ),
  );

export const publishRawEvent = (runId: string, raw: string): Effect.Effect<void> =>
  Effect.asVoid(Effect.flatMap(ensureRawPubSub(runId), (pubSub) => PubSub.publish(pubSub, raw)));

export const watchTier1Live = (runId: string): Stream.Stream<MillEvent, never> =>
  Stream.unwrapScoped(Effect.map(ensureTier1PubSub(runId), (pubSub) => Stream.fromPubSub(pubSub)));

export const watchRawLive = (runId: string): Stream.Stream<string, never> =>
  Stream.unwrapScoped(Effect.map(ensureRawPubSub(runId), (pubSub) => Stream.fromPubSub(pubSub)));

export const watchTier1GlobalLive = (): Stream.Stream<MillEvent, never> =>
  Stream.unwrapScoped(Effect.map(ensureTier1GlobalPubSub(), (pubSub) => Stream.fromPubSub(pubSub)));
