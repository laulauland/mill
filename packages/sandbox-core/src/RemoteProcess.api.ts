import type { Effect, Sink, Stream } from "effect";
import type { RemoteProcessError } from "./errors.api";

export interface RemoteProcess {
  readonly stdin: Sink.Sink<void, Uint8Array, never, RemoteProcessError>;
  readonly stdout: Stream.Stream<Uint8Array, RemoteProcessError>;
  readonly stderr: Stream.Stream<Uint8Array, RemoteProcessError>;
  readonly exitCode: Effect.Effect<number, RemoteProcessError>;
  readonly kill: (signal?: string) => Effect.Effect<void, RemoteProcessError>;
}
