import { Context, Data, Effect, PlatformError, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { decodeAcpMessage } from "./acp-message.codec";

export class AcpSessionError extends Data.TaggedError("AcpSessionError")<{
  readonly sessionId: string;
  readonly message: string;
}> {}

export type AcpMessage = {
  readonly type: "text" | "tool_call" | "tool_result" | "error";
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
};

export type AcpSession = {
  readonly sessionId: string;
  readonly send: (message: string) => Effect.Effect<void, AcpSessionError>;
  readonly receive: Stream.Stream<AcpMessage, AcpSessionError>;
  readonly close: Effect.Effect<void, AcpSessionError>;
};

export const makeAcpSession = ({
  sessionId,
  command,
  args,
  env,
}: {
  sessionId: string;
  command: string;
  args: ReadonlyArray<string>;
  env?: Readonly<Record<string, string>>;
}) =>
  Effect.gen(function* () {
    const cmd = ChildProcess.make(command, [...args], {
      env,
      extendEnv: true,
    });

    const handle = yield* Effect.fromYieldable(cmd).pipe(
      Effect.mapError(
        (error: PlatformError.PlatformError) =>
          new AcpSessionError({
            sessionId,
            message: `Failed to spawn ACP process: ${error.message}`,
          }),
      ),
    );

    const send = (message: string): Effect.Effect<void, AcpSessionError> =>
      Stream.fromIterable([new TextEncoder().encode(`${message}\n`)]).pipe(
        Stream.run(handle.stdin),
        Effect.mapError(
          (error: PlatformError.PlatformError) =>
            new AcpSessionError({
              sessionId,
              message: `Send failed: ${error.message}`,
            }),
        ),
      );

    const decoded = handle.stdout.pipe(Stream.map((chunk) => new TextDecoder().decode(chunk)));

    const lines = decoded.pipe(Stream.splitLines);

    const filtered = lines.pipe(Stream.filter((line: string) => line.trim().length > 0));

    const stdoutMessages = filtered.pipe(
      Stream.mapEffect((line: string) => decodeAcpMessage(line)),
      Stream.mapError(
        (error: PlatformError.PlatformError) =>
          new AcpSessionError({
            sessionId,
            message: `Receive failed: ${error.message}`,
          }),
      ),
    );

    const stderrMessages = handle.stderr.pipe(
      Stream.map((chunk) => new TextDecoder().decode(chunk)),
      Stream.splitLines,
      Stream.filter((line: string) => line.trim().length > 0),
      Stream.map((line: string) => ({ type: "error" as const, content: line })),
      Stream.mapError(
        (error: PlatformError.PlatformError) =>
          new AcpSessionError({
            sessionId,
            message: `Receive failed: ${error.message}`,
          }),
      ),
    );

    const receive = stdoutMessages.pipe(Stream.merge(stderrMessages));

    const close = handle.kill().pipe(
      Effect.mapError(
        (error: PlatformError.PlatformError) =>
          new AcpSessionError({
            sessionId,
            message: `Failed to close ACP process: ${error.message}`,
          }),
      ),
    );

    return {
      sessionId,
      send,
      receive,
      close,
    } satisfies AcpSession;
  });

export const AcpSession = Context.Service<AcpSession>("@mill/provider-acp/AcpSession");
