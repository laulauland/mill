import * as FileSystem from "@effect/platform/FileSystem";
import { Data, Effect, Fiber, Queue, Ref, Scope } from "effect";
import type {
  DriverProcessConfig,
  DriverSpawnEvent,
  DriverSpawnInput,
  DriverSpawnOutput,
} from "@mill/core";
import type {
  AcpNewSessionResult,
  AcpPromptResponse,
  AcpSessionUpdate,
  AcpStopReason,
  JsonRpcNotification,
} from "./acp.codec";
import {
  makeAcpTransport,
  type AcpTransport,
  type AcpTransportError,
  type AcpTransportRequestHandler,
} from "./acp-transport.effect";

export class AcpClientError extends Data.TaggedError("AcpClientError")<{
  message: string;
}> {}

const toMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toAcpClientError = (error: unknown): AcpClientError =>
  error instanceof AcpClientError ? error : new AcpClientError({ message: toMessage(error) });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const mapStopReasonToExitCode = (stopReason: AcpStopReason): number => {
  if (stopReason === "end_turn") return 0;
  if (stopReason === "max_tokens") return 0;
  if (stopReason === "max_turn_requests") return 0;
  if (stopReason === "cancelled") return 1;
  if (stopReason === "refusal") return 1;
  return 1;
};

const mapStopReason = (stopReason: AcpStopReason): string | undefined => {
  if (stopReason === "end_turn") return undefined;
  return stopReason;
};

const sessionUpdateToDriverEvents = (update: AcpSessionUpdate): ReadonlyArray<DriverSpawnEvent> => {
  const updateType = update.sessionUpdate;

  if (updateType === "tool_call") {
    const toolName =
      typeof update.name === "string" && update.name.length > 0 ? update.name : "unknown";
    return [{ type: "tool_call", toolName }];
  }

  if (updateType === "agent_message_chunk") {
    const text = typeof update.text === "string" ? update.text : "";
    return [{ type: "message_chunk", text }];
  }

  if (updateType === "agent_thought_chunk") {
    const text = typeof update.text === "string" ? update.text : "";
    return [{ type: "thought_chunk", text }];
  }

  if (updateType === "plan") {
    const steps = Array.isArray(update.steps)
      ? (update.steps as ReadonlyArray<unknown>).filter(
          (step): step is string => typeof step === "string",
        )
      : [];
    return [{ type: "plan", steps }];
  }

  return [{ type: "milestone", message: updateType }];
};

const isSessionUpdate = (notification: JsonRpcNotification): boolean =>
  notification.method === "session/update";

const extractSessionUpdate = (notification: JsonRpcNotification): AcpSessionUpdate | undefined => {
  const params = notification.params;

  if (!isRecord(params)) return undefined;
  if (typeof params.sessionUpdate !== "string") return undefined;

  return {
    sessionUpdate: params.sessionUpdate as AcpSessionUpdate["sessionUpdate"],
    sessionId: typeof params.sessionId === "string" ? params.sessionId : "",
    ...params,
  };
};

const buildRequestHandlers = (): ReadonlyArray<AcpTransportRequestHandler> => [
  {
    method: "session/requestPermission",
    handle: () => Effect.succeed({ outcome: "allow", scope: "always" }),
  },
  {
    method: "fs/readTextFile",
    handle: (params) =>
      Effect.gen(function* () {
        if (!isRecord(params) || typeof params.path !== "string") {
          return { error: "Invalid params: expected { path: string }" };
        }

        const fileSystem = yield* FileSystem.FileSystem;
        const content = yield* Effect.mapError(
          fileSystem.readFileString(params.path as string),
          (error) => ({ message: `Failed to read file: ${toMessage(error)}` }) as AcpTransportError,
        );

        return { content };
      }),
  },
  {
    method: "fs/writeTextFile",
    handle: (params) =>
      Effect.gen(function* () {
        if (
          !isRecord(params) ||
          typeof params.path !== "string" ||
          typeof params.content !== "string"
        ) {
          return { error: "Invalid params: expected { path: string, content: string }" };
        }

        const fileSystem = yield* FileSystem.FileSystem;

        yield* Effect.mapError(
          fileSystem.writeFileString(params.path as string, params.content as string),
          (error) =>
            ({ message: `Failed to write file: ${toMessage(error)}` }) as AcpTransportError,
        );

        return { ok: true };
      }),
  },
];

const initializeAcpAgent = (transport: AcpTransport): Effect.Effect<void, AcpClientError> =>
  Effect.gen(function* () {
    yield* Effect.mapError(
      transport.sendRequest("initialize", {
        protocolVersion: "0.1",
        clientInfo: { name: "mill", version: "0.1.0" },
        capabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
      }),
      toAcpClientError,
    );
  });

const createSession = (
  transport: AcpTransport,
  workingDirectory: string,
): Effect.Effect<string, AcpClientError> =>
  Effect.gen(function* () {
    const result = yield* Effect.mapError(
      transport.sendRequest("session/new", { workingDirectory }),
      toAcpClientError,
    );

    if (!isRecord(result) || typeof result.sessionId !== "string") {
      return yield* Effect.fail(
        new AcpClientError({ message: "Invalid session/new response: missing sessionId" }),
      );
    }

    return (result as AcpNewSessionResult).sessionId;
  });

const sendPromptAndCollect = (
  transport: AcpTransport,
  sessionId: string,
  promptText: string,
): Effect.Effect<
  {
    readonly events: ReadonlyArray<DriverSpawnEvent>;
    readonly accumulatedText: string;
    readonly stopReason: AcpStopReason;
  },
  AcpClientError
> =>
  Effect.gen(function* () {
    const eventsRef = yield* Ref.make<ReadonlyArray<DriverSpawnEvent>>([]);
    const textRef = yield* Ref.make("");

    // Send the prompt request. This resolves when the agent responds with PromptResponse.
    // Meanwhile, session/update notifications arrive on the notification queue.
    // We fork the notification consumer first, then send the request.
    const promptDone = yield* Effect.fork(
      Effect.mapError(
        transport.sendRequest("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: promptText }],
        }),
        toAcpClientError,
      ),
    );

    // Consume notifications until the prompt request completes
    const consumeNotifications = Effect.gen(function* () {
      while (true) {
        const notification = yield* Queue.take(transport.notifications);

        if (!isSessionUpdate(notification)) {
          continue;
        }

        const update = extractSessionUpdate(notification);

        if (update === undefined) {
          continue;
        }

        const driverEvents = sessionUpdateToDriverEvents(update);
        yield* Ref.update(eventsRef, (current) => [...current, ...driverEvents]);

        // Accumulate text from message chunks
        if (update.sessionUpdate === "agent_message_chunk" && typeof update.text === "string") {
          yield* Ref.update(textRef, (current) => current + update.text);
        }
      }
    });

    const consumerFiber = yield* Effect.fork(consumeNotifications);

    // Wait for the prompt response
    const promptResult = yield* Fiber.join(promptDone);

    // Give the notification consumer a moment to drain, then interrupt it
    yield* Effect.sleep("50 millis");
    yield* Fiber.interrupt(consumerFiber);

    // Drain any remaining notifications in the queue
    const remainingNotifications = yield* Queue.takeAll(transport.notifications);

    for (const notification of remainingNotifications) {
      if (!isSessionUpdate(notification)) continue;

      const update = extractSessionUpdate(notification);
      if (update === undefined) continue;

      const driverEvents = sessionUpdateToDriverEvents(update);
      yield* Ref.update(eventsRef, (current) => [...current, ...driverEvents]);

      if (update.sessionUpdate === "agent_message_chunk" && typeof update.text === "string") {
        yield* Ref.update(textRef, (current) => current + update.text);
      }
    }

    const events = yield* Ref.get(eventsRef);
    const accumulatedText = yield* Ref.get(textRef);

    if (!isRecord(promptResult) || typeof promptResult.stopReason !== "string") {
      return yield* Effect.fail(
        new AcpClientError({ message: "Invalid session/prompt response: missing stopReason" }),
      );
    }

    return {
      events,
      accumulatedText,
      stopReason: (promptResult as AcpPromptResponse).stopReason,
    };
  });

export const runAcpSession = (
  processConfig: DriverProcessConfig,
  input: DriverSpawnInput,
): Effect.Effect<DriverSpawnOutput, AcpClientError, Scope.Scope> =>
  Effect.gen(function* () {
    const requestHandlers = buildRequestHandlers();

    const transport = yield* Effect.mapError(
      makeAcpTransport(processConfig, requestHandlers),
      toAcpClientError,
    );

    yield* Effect.logDebug("mill.driver-acp:initialize", {
      runId: input.runId,
      spawnId: input.spawnId,
      command: processConfig.command,
    });

    yield* initializeAcpAgent(transport);

    yield* Effect.logDebug("mill.driver-acp:session-new", {
      runId: input.runId,
      spawnId: input.spawnId,
    });

    const sessionId = yield* createSession(transport, input.runDirectory);

    yield* Effect.logDebug("mill.driver-acp:prompt", {
      runId: input.runId,
      spawnId: input.spawnId,
      sessionId,
      agent: input.agent,
      model: input.model,
    });

    const promptText = `[System Instructions]\n${input.systemPrompt}\n\n[Task]\n${input.prompt}`;

    const { events, accumulatedText, stopReason } = yield* sendPromptAndCollect(
      transport,
      sessionId,
      promptText,
    );

    yield* Effect.logDebug("mill.driver-acp:complete", {
      runId: input.runId,
      spawnId: input.spawnId,
      sessionId,
      stopReason,
      eventCount: events.length,
    });

    return {
      events,
      result: {
        text: accumulatedText,
        sessionRef: sessionId,
        agent: input.agent,
        model: input.model,
        driver: "acp",
        exitCode: mapStopReasonToExitCode(stopReason),
        stopReason: mapStopReason(stopReason),
      },
    } satisfies DriverSpawnOutput;
  });
