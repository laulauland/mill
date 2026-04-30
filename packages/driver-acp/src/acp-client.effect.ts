import { Data, Effect, Scope } from "effect";
import {
  SpawnAgent,
  type AgentAdapter,
  type AgentEvent,
  type AgentStream,
  type ConfigOption,
} from "spawn-agent";
import type {
  DriverProcessConfig,
  DriverSpawnEvent,
  DriverSpawnInput,
  DriverSpawnOutput,
  DriverTaskSession,
  DriverTaskSessionInput,
  DriverTaskTurnInput,
  DriverTaskTurnOutput,
} from "@mill/core";

export class AcpClientError extends Data.TaggedError("AcpClientError")<{
  message: string;
}> {}

const toMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toAcpClientError = (error: unknown): AcpClientError =>
  error instanceof AcpClientError ? error : new AcpClientError({ message: toMessage(error) });

const makeAdapter = (
  name: string,
  processConfig: DriverProcessConfig | undefined,
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

const eventToDriverEvents = (event: AgentEvent): ReadonlyArray<DriverSpawnEvent> => {
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
  input: DriverTaskSessionInput,
  turn: DriverTaskTurnInput,
  sessionId: string,
  setActiveStream: (stream: AgentStream | undefined) => void,
): Effect.Effect<DriverTaskTurnOutput, AcpClientError> =>
  Effect.tryPromise({
    try: async () => {
      const configOptions = agent.configOptionsFor(sessionId);
      const modelPreference = findModelPreference(configOptions, input.model);
      const stream = agent.prompt(sessionId, {
        prompt: turn.prompt,
        systemPrompt: input.systemPrompt,
        ...(modelPreference === undefined ? {} : { modelPreference }),
      });
      const events: Array<DriverSpawnEvent> = [];

      setActiveStream(stream);

      try {
        for await (const event of stream) {
          events.push(...eventToDriverEvents(event));
        }

        const result = await stream.completion;
        const stopReason = String(result.stopReason);

        return {
          events,
          result: {
            text: result.text,
            sessionRef: sessionId,
            role: input.agent,
            model: input.model,
            driver: "acp",
            exitCode: mapStopReasonToExitCode(stopReason),
            stopReason: mapStopReason(stopReason),
          },
        } satisfies DriverTaskTurnOutput;
      } finally {
        setActiveStream(undefined);
      }
    },
    catch: toAcpClientError,
  });

export const createAcpTaskSession = (
  name: string,
  processConfig: DriverProcessConfig | undefined,
  input: DriverTaskSessionInput,
): Effect.Effect<DriverTaskSession, AcpClientError> =>
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

    const sessionId = yield* Effect.tryPromise({
      try: () => agent.createSession({ cwd: input.runDirectory, systemPrompt: input.systemPrompt }),
      catch: async (error) => {
        await agent.close().catch(() => undefined);
        return toAcpClientError(error);
      },
    });

    let activeStream: AgentStream | undefined;
    let closed = false;

    const close = (): Effect.Effect<void, AcpClientError> =>
      Effect.tryPromise({
        try: async () => {
          if (closed) return;
          closed = true;
          await agent.closeSession(sessionId).catch(() => undefined);
          await agent.close();
        },
        catch: toAcpClientError,
      });

    return {
      sessionRef: sessionId,
      startTurn: (turn) =>
        collectPrompt(agent, input, turn, sessionId, (stream) => {
          activeStream = stream;
        }),
      cancelTurn: () =>
        Effect.tryPromise({
          try: async () => {
            const stream = activeStream;
            if (stream !== undefined) {
              await stream.cancel().catch(() => undefined);
            }
            await agent.cancel(sessionId).catch(() => undefined);
          },
          catch: toAcpClientError,
        }),
      close,
    } satisfies DriverTaskSession;
  });

const toTaskSessionInput = (input: DriverSpawnInput): DriverTaskSessionInput => ({
  runId: input.runId,
  runDirectory: input.runDirectory,
  taskId: input.spawnId,
  agent: input.agent,
  systemPrompt: input.systemPrompt,
  model: input.model,
});

export const runAcpSession = (
  name: string,
  processConfig: DriverProcessConfig | undefined,
  input: DriverSpawnInput,
): Effect.Effect<DriverSpawnOutput, AcpClientError, Scope.Scope> =>
  Effect.gen(function* () {
    const session = yield* Effect.acquireRelease(
      createAcpTaskSession(name, processConfig, toTaskSessionInput(input)),
      (taskSession) => Effect.orDie(taskSession.close()),
    );

    const turnOutput = yield* session.startTurn({ prompt: input.prompt });

    return {
      events: turnOutput.events,
      raw: turnOutput.raw,
      result: {
        text: turnOutput.result.text,
        sessionRef: turnOutput.result.sessionRef,
        agent: turnOutput.result.role,
        model: turnOutput.result.model,
        driver: turnOutput.result.driver,
        exitCode: turnOutput.result.exitCode,
        stopReason: turnOutput.result.stopReason,
        errorMessage: turnOutput.result.errorMessage,
      },
    } satisfies DriverSpawnOutput;
  });
