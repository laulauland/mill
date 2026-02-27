import * as Command from "@effect/platform/Command";
import { Data, Deferred, Effect, HashMap, Queue, Ref, Scope, Sink, Stream } from "effect";
import type { DriverProcessConfig } from "@mill/core";
import {
  decodeJsonRpcMessage,
  encodeJsonRpcNotification,
  encodeJsonRpcRequest,
  encodeJsonRpcResponse,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./acp.codec";

export class AcpTransportError extends Data.TaggedError("AcpTransportError")<{
  message: string;
}> {}

export type AcpTransportRequestHandler = {
  readonly method: string;
  readonly handle: (params: unknown) => Effect.Effect<unknown, AcpTransportError>;
};

export type AcpTransport = {
  readonly sendRequest: (
    method: string,
    params?: unknown,
  ) => Effect.Effect<unknown, AcpTransportError>;
  readonly sendNotification: (
    method: string,
    params?: unknown,
  ) => Effect.Effect<void, AcpTransportError>;
  readonly notifications: Queue.Dequeue<JsonRpcNotification>;
};

const toMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const encodeJsonRpcErrorResponse = (id: number, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n";

export const makeAcpTransport = (
  processConfig: DriverProcessConfig,
  requestHandlers: ReadonlyArray<AcpTransportRequestHandler>,
): Effect.Effect<AcpTransport, AcpTransportError, Scope.Scope> =>
  Effect.gen(function* () {
    const nextIdRef = yield* Ref.make(0);
    const pendingRequests = yield* Ref.make(
      HashMap.empty<number, Deferred.Deferred<unknown, AcpTransportError>>(),
    );
    const notificationQueue = yield* Queue.unbounded<JsonRpcNotification>();

    const command = Command.make(processConfig.command, ...processConfig.args).pipe(
      Command.stdin("pipe"),
      Command.stdout("pipe"),
      Command.stderr("pipe"),
      processConfig.env !== undefined && Object.keys(processConfig.env).length > 0
        ? Command.env(processConfig.env)
        : (cmd: Command.Command) => cmd,
    );

    const processHandle = yield* Effect.mapError(
      Command.start(command),
      (error) =>
        new AcpTransportError({ message: `Failed to start ACP process: ${toMessage(error)}` }),
    );

    const stdinQueue = yield* Queue.unbounded<Uint8Array>();

    yield* Effect.forkScoped(
      Effect.catchAll(
        Stream.run(
          Stream.fromQueue(stdinQueue),
          processHandle.stdin,
        ),
        (error) =>
          Effect.logDebug("mill.driver-acp:stdin-writer-error", { error: toMessage(error) }),
      ),
    );

    const writeToStdin = (data: string): Effect.Effect<void, AcpTransportError> =>
      Effect.mapError(
        Queue.offer(stdinQueue, new TextEncoder().encode(data)),
        (error) =>
          new AcpTransportError({ message: `Failed to write to stdin: ${toMessage(error)}` }),
      );

    const handleResponse = (response: JsonRpcResponse): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const pending = yield* Ref.get(pendingRequests);
        const deferred = HashMap.get(pending, response.id);

        if (deferred._tag === "None") {
          return;
        }

        yield* Ref.update(pendingRequests, HashMap.remove(response.id));

        if (response.error !== undefined) {
          yield* Deferred.fail(
            deferred.value,
            new AcpTransportError({
              message: `JSON-RPC error (${response.error.code}): ${response.error.message}`,
            }),
          );
        } else {
          yield* Deferred.succeed(deferred.value, response.result);
        }
      });

    const handleIncomingRequest = (
      request: JsonRpcRequest,
    ): Effect.Effect<void, AcpTransportError> =>
      Effect.gen(function* () {
        const handler = requestHandlers.find((h) => h.method === request.method);

        if (handler === undefined) {
          yield* writeToStdin(
            encodeJsonRpcErrorResponse(request.id, -32601, `Method not found: ${request.method}`),
          );
          return;
        }

        const result = yield* Effect.catchAll(handler.handle(request.params), (error) =>
          Effect.gen(function* () {
            yield* writeToStdin(encodeJsonRpcErrorResponse(request.id, -32000, error.message));
            return undefined;
          }),
        );

        if (result !== undefined) {
          yield* writeToStdin(encodeJsonRpcResponse(request.id, result));
        }
      });

    const handleNotification = (notification: JsonRpcNotification): Effect.Effect<void, never> =>
      Queue.offer(notificationQueue, notification);

    const routeMessage = (message: JsonRpcMessage): Effect.Effect<void, AcpTransportError> => {
      if ("id" in message && !("method" in message)) {
        return handleResponse(message as JsonRpcResponse);
      }

      if ("id" in message && "method" in message) {
        return handleIncomingRequest(message as JsonRpcRequest);
      }

      return handleNotification(message as JsonRpcNotification);
    };

    const stdoutReader = Stream.runForEach(
      Stream.map(Stream.splitLines(Stream.decodeText(processHandle.stdout)), (line) => line.trim()),
      (line) =>
        Effect.gen(function* () {
          if (line.length === 0) {
            return;
          }

          const messageResult = yield* Effect.either(decodeJsonRpcMessage(line));

          if (messageResult._tag === "Left") {
            yield* Effect.logDebug("mill.driver-acp:decode-error", {
              error: messageResult.left.message,
              raw: line,
            });
            return;
          }

          yield* routeMessage(messageResult.right);
        }),
    );

    const stderrReader = Stream.runForEach(
      Stream.splitLines(Stream.decodeText(processHandle.stderr)),
      (line) => Effect.logDebug("mill.driver-acp:stderr", { line }),
    );

    yield* Effect.forkScoped(
      Effect.catchAll(stdoutReader, (error) =>
        Effect.logDebug("mill.driver-acp:stdout-reader-error", { error: toMessage(error) }),
      ),
    );
    yield* Effect.forkScoped(
      Effect.catchAll(stderrReader, (error) =>
        Effect.logDebug("mill.driver-acp:stderr-reader-error", { error: toMessage(error) }),
      ),
    );

    const sendRequest = (
      method: string,
      params?: unknown,
    ): Effect.Effect<unknown, AcpTransportError> =>
      Effect.gen(function* () {
        const id = yield* Ref.updateAndGet(nextIdRef, (current) => current + 1);
        const deferred = yield* Deferred.make<unknown, AcpTransportError>();

        yield* Ref.update(pendingRequests, HashMap.set(id, deferred));
        yield* writeToStdin(encodeJsonRpcRequest(id, method, params));

        return yield* Deferred.await(deferred);
      });

    const sendNotification = (
      method: string,
      params?: unknown,
    ): Effect.Effect<void, AcpTransportError> =>
      writeToStdin(encodeJsonRpcNotification(method, params));

    return {
      sendRequest,
      sendNotification,
      notifications: notificationQueue,
    } satisfies AcpTransport;
  });
