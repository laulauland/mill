import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Stream } from "effect";
import { Stdio } from "effect/Stdio";
import { Terminal } from "effect/Terminal";

const withOutputLayer = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  Effect.provide(effect, BunServices.layer) as Effect.Effect<A, E, never>;

export const print = (text: string): Effect.Effect<void> =>
  withOutputLayer(
    Effect.flatMap(Effect.service(Terminal), (terminal) => terminal.display(`${text}\n`)).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          process.stdout.write(`${text}\n`);
        }),
      ),
    ),
  );

export const printJson = (value: unknown): Effect.Effect<void> =>
  print(JSON.stringify(value, null, 2));

export const printNdjson = (value: unknown): Effect.Effect<void> => print(JSON.stringify(value));

export const printError = (text: string): Effect.Effect<void> =>
  withOutputLayer(
    Effect.flatMap(Effect.service(Stdio), (stdio) =>
      Stream.make(`${text}\n`).pipe(Stream.run(stdio.stderr())),
    ).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          process.stderr.write(`${text}\n`);
        }),
      ),
    ),
  );
