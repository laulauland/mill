import { Effect, PubSub, Stream } from "effect";
import type { MillEvent } from "../domain/event.schema";

export interface IoStreamEvent {
  readonly runId: string;
  readonly source: "driver" | "program";
  readonly stream: "stdout" | "stderr";
  readonly line: string;
  readonly timestamp: string;
  readonly spawnId?: string;
}

const tier1PubSubByRun = new Map<string, PubSub.PubSub<MillEvent>>();
const ioPubSubByRun = new Map<string, PubSub.PubSub<IoStreamEvent>>();
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

const ensureIoPubSub = (runId: string): Effect.Effect<PubSub.PubSub<IoStreamEvent>> =>
  Effect.suspend(() => {
    const existing = ioPubSubByRun.get(runId);

    if (existing !== undefined) {
      return Effect.succeed(existing);
    }

    return Effect.tap(PubSub.unbounded<IoStreamEvent>(), (pubSub) =>
      Effect.sync(() => {
        ioPubSubByRun.set(runId, pubSub);
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

export const publishIoEvent = (event: IoStreamEvent): Effect.Effect<void> =>
  Effect.asVoid(
    Effect.flatMap(ensureIoPubSub(event.runId), (pubSub) => PubSub.publish(pubSub, event)),
  );

export const watchTier1Live = (runId: string): Stream.Stream<MillEvent, never> =>
  Stream.unwrapScoped(Effect.map(ensureTier1PubSub(runId), (pubSub) => Stream.fromPubSub(pubSub)));

export const watchIoLive = (runId: string): Stream.Stream<IoStreamEvent, never> =>
  Stream.unwrapScoped(Effect.map(ensureIoPubSub(runId), (pubSub) => Stream.fromPubSub(pubSub)));

export const watchTier1GlobalLive = (): Stream.Stream<MillEvent, never> =>
  Stream.unwrapScoped(Effect.map(ensureTier1GlobalPubSub(), (pubSub) => Stream.fromPubSub(pubSub)));
