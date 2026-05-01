import { Data, Effect } from "effect";
import {
  SpawnAgent,
  type AgentAdapter,
  type AgentEvent,
  type AgentStream,
  type ConfigOption,
  type SessionId,
} from "spawn-agent";
import type {
  AgentProcessConfig,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionInput,
  AgentTurnInput,
  AgentTurnOutput,
} from "@mill/core";

export class AcpClientError extends Data.TaggedError("AcpClientError")<{
  message: string;
}> {}

const isAcpClientError = (error: unknown): error is AcpClientError =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "AcpClientError";

const toMessage = (error: unknown): string => String(error);

const toAcpClientError = (error: unknown): AcpClientError =>
  isAcpClientError(error) ? error : new AcpClientError({ message: toMessage(error) });

const logNonFatalAcpError = (operation: string, error: AcpClientError): Effect.Effect<void> =>
  Effect.logWarning("mill.acp:non-fatal-operation-failed", { operation, message: error.message });

const makeAdapter = (
  name: string,
  processConfig: AgentProcessConfig | undefined,
): AgentAdapter | "claude" | "codex" | "pi" => {
  if (processConfig === undefined) {
    if (name === "claude" || name === "codex" || name === "pi") {
      return name;
    }
  }

  const command = processConfig?.command ?? name;
  const args = processConfig?.args ?? [];
  const env = processConfig?.env ?? {};

  return {
    id: name,
    displayName: `${name} ACP`,
    resolve: async () => ({
      bin: command,
      args,
      env,
    }),
  } satisfies AgentAdapter;
};

const mapStopReasonToExitCode = (stopReason: string): number => {
  if (stopReason === "end_turn") return 0;
  if (stopReason === "max_tokens") return 0;
  if (stopReason === "max_turn_requests") return 0;
  return 1;
};

const mapStopReason = (stopReason: string): string | undefined =>
  stopReason === "end_turn" ? undefined : stopReason;

const planEntriesToSteps = (event: Extract<AgentEvent, { type: "plan" }>): ReadonlyArray<string> =>
  event.entries.map((entry) => entry.content);

const eventToAgentEvents = (event: AgentEvent): ReadonlyArray<AgentRuntimeEvent> => {
  if (event.type === "text-delta") {
    return [{ type: "message_chunk", text: event.text }];
  }

  if (event.type === "thinking-delta") {
    return [{ type: "thought_chunk", text: event.text }];
  }

  if (event.type === "tool-call") {
    return [{ type: "tool_call", toolName: event.tool }];
  }

  if (event.type === "plan") {
    return [{ type: "plan", steps: planEntriesToSteps(event) }];
  }

  if (event.type === "config-options") {
    return [{ type: "milestone", message: "config-options" }];
  }

  if (event.type === "available-commands") {
    return [{ type: "milestone", message: "available-commands" }];
  }

  if (event.type === "mode-changed") {
    return [{ type: "milestone", message: `mode:${event.modeId}` }];
  }

  if (event.type === "usage") {
    return [{ type: "milestone", message: "usage" }];
  }

  if (event.type === "session-info") {
    return [{ type: "milestone", message: event.title ?? "session-info" }];
  }

  if (event.type === "tool-call-update") {
    return [{ type: "milestone", message: event.title ?? `tool:${event.toolCallId}` }];
  }

  if (event.type === "tool-call-cancelled") {
    return [{ type: "milestone", message: `tool-cancelled:${event.toolCallId}` }];
  }

  if (event.type === "permission-request") {
    return [{ type: "milestone", message: `permission:${event.request.toolCallId}` }];
  }

  return [];
};

const isSelectModelOption = (option: ConfigOption): boolean =>
  option.type === "select" && (option.category === "model" || option.id === "model");

const optionContainsValue = (
  option: Extract<ConfigOption, { type: "select" }>,
  value: string,
): boolean =>
  option.options.some((entry) =>
    "value" in entry ? entry.value === value : entry.options.some((child) => child.value === value),
  );

const findModelPreference = (
  options: ReadonlyArray<ConfigOption>,
  model: string,
): { readonly configId: string; readonly value: string } | undefined => {
  const modelOption = options.find(isSelectModelOption);

  if (modelOption === undefined || modelOption.type !== "select") {
    return undefined;
  }

  if (!optionContainsValue(modelOption, model)) {
    return undefined;
  }

  return {
    configId: modelOption.id,
    value: model,
  };
};

const collectPrompt = (
  agent: SpawnAgent,
  input: AgentSessionInput,
  turn: AgentTurnInput,
  sessionId: SessionId,
  setActiveStream: (stream: AgentStream | undefined) => void,
): Effect.Effect<AgentTurnOutput, AcpClientError> =>
  Effect.gen(function* () {
    const configOptions = agent.configOptionsFor(sessionId);
    const modelPreference = findModelPreference(configOptions, input.model);
    const stream = agent.prompt(sessionId, {
      prompt: turn.prompt,
      systemPrompt: input.system,
      ...(modelPreference === undefined ? {} : { modelPreference }),
    });

    setActiveStream(stream);

    return yield* Effect.tryPromise({
      try: async () => {
        const events: Array<AgentRuntimeEvent> = [];

        for await (const event of stream) {
          events.push(...eventToAgentEvents(event));
        }

        const result = await stream.completion;
        const stopReason = String(result.stopReason);

        return {
          events,
          result: {
            text: result.text,
            sessionRef: sessionId,
            role: input.role,
            model: input.model,
            provider: "acp",
            exitCode: mapStopReasonToExitCode(stopReason),
            stopReason: mapStopReason(stopReason),
          },
        } satisfies AgentTurnOutput;
      },
      catch: toAcpClientError,
    });
  }).pipe(Effect.ensuring(Effect.sync(() => setActiveStream(undefined))));

export const createAcpSession = (
  name: string,
  processConfig: AgentProcessConfig | undefined,
  input: AgentSessionInput,
): Effect.Effect<AgentSession, AcpClientError> =>
  Effect.gen(function* () {
    const adapter = makeAdapter(name, processConfig);

    const agent = yield* Effect.tryPromise({
      try: () =>
        SpawnAgent.connect(adapter, {
          cwd: input.runDirectory,
          permission: "auto-allow",
          stderrTailLimit: 16_384,
        }),
      catch: toAcpClientError,
    });

    const closeAgentAfterSessionFailure = Effect.tryPromise({
      try: () => agent.close(),
      catch: toAcpClientError,
    }).pipe(Effect.catch((error) => logNonFatalAcpError("closeAgentAfterSessionFailure", error)));

    const sessionId = yield* Effect.tryPromise({
      try: () => agent.createSession({ cwd: input.runDirectory, systemPrompt: input.system }),
      catch: toAcpClientError,
    }).pipe(Effect.tapError(() => closeAgentAfterSessionFailure));

    let activeStream: AgentStream | undefined;
    let closed = false;

    const close = (): Effect.Effect<void, AcpClientError> =>
      Effect.gen(function* () {
        if (closed) return;
        closed = true;
        yield* Effect.tryPromise({
          try: () => agent.closeSession(sessionId),
          catch: toAcpClientError,
        }).pipe(Effect.catch((error) => logNonFatalAcpError("closeSession", error)));
        yield* Effect.tryPromise({
          try: () => agent.close(),
          catch: toAcpClientError,
        });
      });

    return {
      sessionRef: sessionId,
      startTurn: (turn) =>
        collectPrompt(agent, input, turn, sessionId, (stream) => {
          activeStream = stream;
        }),
      cancelTurn: () =>
        Effect.gen(function* () {
          const stream = activeStream;
          if (stream !== undefined) {
            yield* Effect.tryPromise({
              try: () => stream.cancel(),
              catch: toAcpClientError,
            }).pipe(Effect.catch((error) => logNonFatalAcpError("streamCancel", error)));
          }
          yield* Effect.tryPromise({
            try: () => agent.cancel(sessionId),
            catch: toAcpClientError,
          }).pipe(Effect.catch((error) => logNonFatalAcpError("agentCancel", error)));
        }),
      close,
    } satisfies AgentSession;
  });
