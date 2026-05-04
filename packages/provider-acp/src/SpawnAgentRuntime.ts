import { Data, Effect, Layer } from "effect";
import { AgentRuntime, AgentRuntimeError, type AgentRuntimeInput } from "@mill/core";
import type { TaskEvent } from "@mill/core";
import { SpawnAgent, type AgentEvent, type SupportedAgentId, type ConfigOption } from "spawn-agent";

export class SpawnAgentRuntimeError extends Data.TaggedError("SpawnAgentRuntimeError")<{
  readonly provider: string;
  readonly model: string;
  readonly message: string;
}> {}

const supportedAgents = new Set(["claude", "codex", "pi"]);

const now = (): string => new Date().toISOString();

const isSupportedAgentId = (provider: string): provider is SupportedAgentId =>
  supportedAgents.has(provider);

const flattenConfigValues = (
  option: ConfigOption,
): ReadonlyArray<{ value: string; name: string }> => {
  if (option.type !== "select") {
    return [];
  }

  return option.options.flatMap((entry) => {
    if ("value" in entry) {
      return [{ value: entry.value, name: entry.name }];
    }

    return entry.options.map((nested) => ({ value: nested.value, name: nested.name }));
  });
};

const describeConfigOption = (option: ConfigOption): string => `${option.id} (${option.name})`;

const describeConfigValue = (option: { readonly value: string; readonly name: string }): string =>
  `${option.value} (${option.name})`;

const isDefaultModel = (model: string): boolean => model === "default";

export const resolveModelOption = (
  configOptions: readonly ConfigOption[],
  provider: string,
  model: string,
): Effect.Effect<
  { readonly configId: string; readonly value: string } | undefined,
  SpawnAgentRuntimeError
> =>
  Effect.gen(function* () {
    if (provider === "pi" && isDefaultModel(model)) {
      return undefined;
    }

    const modelOption =
      configOptions.find((option) => option.category === "model") ??
      configOptions.find((option) => option.name.toLowerCase().includes("model"));

    if (modelOption === undefined) {
      const availableOptions = configOptions.map(describeConfigOption).join(", ") || "none";
      const piGuidance =
        provider === "pi"
          ? ' pi-acp exposes model state through ACP models, not spawn-agent configOptions; use pi("default") and configure Pi\'s model externally for now.'
          : "";
      return yield* Effect.fail(
        new SpawnAgentRuntimeError({
          provider,
          model,
          message: `Provider ${provider} does not expose a model config option for requested model ${model}. Available config options: ${availableOptions}.${piGuidance}`,
        }),
      );
    }

    const values = flattenConfigValues(modelOption);
    const selected =
      values.find((option) => option.value === model) ??
      values.find((option) => option.name === model) ??
      values.find((option) => option.value.toLowerCase() === model.toLowerCase()) ??
      values.find((option) => option.name.toLowerCase() === model.toLowerCase());

    if (selected === undefined) {
      const availableValues = values.map(describeConfigValue).join(", ") || "none";
      return yield* Effect.fail(
        new SpawnAgentRuntimeError({
          provider,
          model,
          message: `Provider ${provider} model ${model} does not match a selectable model value or name. Model config option: ${describeConfigOption(modelOption)}. Available model values: ${availableValues}.`,
        }),
      );
    }

    return {
      configId: modelOption.id,
      value: selected.value,
    };
  });

const makeEvent = (taskId: string, event: AgentEvent): TaskEvent | undefined => {
  switch (event.type) {
    case "text-delta":
      return {
        taskId,
        sequence: 0,
        timestamp: now(),
        type: "task:message_chunk",
        payload: { text: event.text },
      };
    case "thinking-delta":
      return {
        taskId,
        sequence: 0,
        timestamp: now(),
        type: "task:thought_chunk",
        payload: { text: event.text },
      };
    case "tool-call":
      return {
        taskId,
        sequence: 0,
        timestamp: now(),
        type: "task:tool_called",
        payload: { toolName: event.tool, arguments: { input: event.input } },
      };
    case "tool-call-update":
      if (event.output === undefined) {
        return undefined;
      }
      return {
        taskId,
        sequence: 0,
        timestamp: now(),
        type: "task:tool_returned",
        payload: {
          toolName: event.title ?? event.toolCallId,
          result: typeof event.output === "string" ? event.output : JSON.stringify(event.output),
        },
      };
    default:
      return undefined;
  }
};

const runSpawnAgent = (
  input: AgentRuntimeInput,
  emit: (event: TaskEvent) => Effect.Effect<void, unknown>,
) =>
  Effect.tryPromise({
    try: async () => {
      if (!isSupportedAgentId(input.agent.provider)) {
        throw new Error(`Unsupported agent provider: ${input.agent.provider}`);
      }

      const agent = await SpawnAgent.connect(input.agent.provider, {
        cwd: process.cwd(),
        permission: "auto-allow",
      });

      try {
        const sessionId = await agent.createSession({ cwd: process.cwd() });
        const modelPreference = findModelPreference(
          agent.configOptionsFor(sessionId),
          input.agent.model,
        );
        const stream = agent.prompt(sessionId, {
          prompt: input.prompt,
          modelPreference,
        });

        for await (const event of stream) {
          const taskEvent = makeEvent(input.taskId, event);
          if (taskEvent !== undefined) {
            await Effect.runPromise(emit(taskEvent));
          }
        }

        const result = await stream.completion;
        await agent.closeSession(sessionId).catch(() => undefined);
        return result.text;
      } finally {
        await agent.close().catch(() => undefined);
      }
    },
    catch: (error) =>
      new AgentRuntimeError({
        provider: input.agent.provider,
        model: input.agent.model,
        message: String(error),
      }),
  });

export const makeSpawnAgentRuntime = Effect.sync(
  () =>
    ({
      runAgent: runSpawnAgent,
    }) satisfies AgentRuntime,
);

export const SpawnAgentRuntimeLive = Layer.effect(AgentRuntime, makeSpawnAgentRuntime);
