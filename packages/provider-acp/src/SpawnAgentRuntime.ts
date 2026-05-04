import nodeProcess from "node:process";
import { Context, Data, Effect, Layer, Option, Queue, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { AgentRuntime, AgentRuntimeError, type AgentRuntimeInput } from "@mill/core";
import type { TaskEvent } from "@mill/core";
import {
  SpawnAgent,
  type AgentAdapter,
  type AgentEvent,
  type ConfigOption,
  type SupportedAgentId,
} from "spawn-agent";

export class SpawnAgentRuntimeError extends Data.TaggedError("SpawnAgentRuntimeError")<{
  readonly provider: string;
  readonly model: string;
  readonly message: string;
}> {}

type Process = {
  readonly cwd: Effect.Effect<string>;
  readonly env: (name: string) => Effect.Effect<string | undefined>;
};

export const Process = Context.Service<Process>("@mill/provider-acp/Process");

export const ProcessLive = Layer.succeed(Process, {
  cwd: Effect.sync(() => nodeProcess.cwd()),
  env: (name) => Effect.sync(() => nodeProcess.env[name]),
} satisfies Process);

const supportedAgents = new Set(["claude", "codex", "pi"]);

const now = (): string => new Date().toISOString();

const isSupportedAgentId = (provider: string): provider is SupportedAgentId =>
  supportedAgents.has(provider);

const appendTail = (current: string, next: unknown, limit = 20_000): string =>
  `${current}${typeof next === "string" ? next : JSON.stringify(next)}`.slice(-limit);

const pathEntries = (pathValue: string): ReadonlyArray<string> =>
  pathValue
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const parseArgs = (value: string): ReadonlyArray<string> =>
  value.split(" ").filter((arg) => arg.length > 0);

type RuntimeConfig = {
  readonly cwd: string;
  readonly path: string;
  readonly piAcpBin: string;
  readonly piAcpArgs: string;
  readonly initializeTimeoutMs: number;
};

type SpawnAgentRuntimeDeps = {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly config: RuntimeConfig;
};

const numberFromEnv = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readRuntimeConfig = Effect.gen(function* () {
  const process = yield* Process;
  const cwd = yield* process.cwd;
  const path = (yield* process.env("PATH")) ?? "";
  const piAcpBin = (yield* process.env("MILL_PI_ACP_BIN")) ?? "pi-acp";
  const piAcpArgs = (yield* process.env("MILL_PI_ACP_ARGS")) ?? "";
  const initializeTimeoutMs = numberFromEnv(
    yield* process.env("MILL_ACP_INITIALIZE_TIMEOUT_MS"),
    30_000,
  );

  return { cwd, path, piAcpBin, piAcpArgs, initializeTimeoutMs } satisfies RuntimeConfig;
});

const executableExistsEffect = (deps: SpawnAgentRuntimeDeps, bin: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const { fs, path, config } = deps;
    const candidates =
      bin.includes("/") || path.isAbsolute(bin)
        ? [bin]
        : pathEntries(config.path).map((entry) => path.join(entry, bin));

    const results = yield* Effect.forEach(
      candidates,
      (candidate) =>
        fs.access(candidate, { ok: true }).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        ),
      { concurrency: "unbounded" },
    );

    return results.some(Boolean);
  });

const makePiAcpAdapter = (bin: string, args: ReadonlyArray<string>): AgentAdapter => ({
  id: "pi",
  displayName: "Pi",
  checkInstalled: () => Promise.resolve(true),
  resolve: () => Promise.resolve({ bin, args, env: {} }),
});

const adapterFor = (
  provider: SupportedAgentId,
  piAcp?: { readonly bin: string; readonly args: ReadonlyArray<string> },
): SupportedAgentId | AgentAdapter =>
  provider === "pi" ? makePiAcpAdapter(piAcp?.bin ?? "pi-acp", piAcp?.args ?? []) : provider;

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

const withTraceTail = (message: string, traceTail: string): string =>
  traceTail.length > 0 ? `${message}\nstderr tail:\n${traceTail}` : message;

const errorMessage = (error: unknown): string =>
  error instanceof SpawnAgentRuntimeError ? error.message : String(error);

const toRuntimeError = (
  input: AgentRuntimeInput,
  error: unknown,
  traceTail: string,
): AgentRuntimeError =>
  new AgentRuntimeError({
    provider: input.agent.provider,
    model: input.agent.model,
    message: withTraceTail(errorMessage(error), traceTail),
  });

const resolvePiAcp = (
  deps: SpawnAgentRuntimeDeps,
  input: AgentRuntimeInput,
): Effect.Effect<
  { readonly bin: string; readonly args: ReadonlyArray<string> } | undefined,
  SpawnAgentRuntimeError
> =>
  Effect.gen(function* () {
    if (input.agent.provider !== "pi") {
      return undefined;
    }

    const { config } = deps;
    const exists = yield* executableExistsEffect(deps, config.piAcpBin);
    if (!exists) {
      return yield* Effect.fail(
        new SpawnAgentRuntimeError({
          provider: "pi",
          model: input.agent.model,
          message:
            "pi provider requires the pi-acp executable. Install it globally with `npm install -g pi-acp` or set MILL_PI_ACP_BIN to its path.",
        }),
      );
    }

    return { bin: config.piAcpBin, args: parseArgs(config.piAcpArgs) };
  });

const runAgentScoped = (
  deps: SpawnAgentRuntimeDeps,
  input: AgentRuntimeInput,
  emit: (event: TaskEvent) => Effect.Effect<void, unknown>,
): Effect.Effect<void, AgentRuntimeError> => {
  let traceTail = "";

  return Effect.gen(function* () {
    if (!isSupportedAgentId(input.agent.provider)) {
      return yield* Effect.fail(
        new SpawnAgentRuntimeError({
          provider: input.agent.provider,
          model: input.agent.model,
          message: `Unsupported agent provider: ${input.agent.provider}`,
        }),
      );
    }

    const { config } = deps;
    const piAcp = yield* resolvePiAcp(deps, input);
    const provider = input.agent.provider;
    const agent = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        SpawnAgent.connect(adapterFor(provider, piAcp), {
          cwd: config.cwd,
          permission: "auto-allow",
          initializeTimeoutMs: config.initializeTimeoutMs,
          stderrTailLimit: 20_000,
          onTrace: (direction, payload) => {
            if (direction === "stderr") {
              traceTail = appendTail(traceTail, payload);
            }
          },
        }),
      ),
      (agent) => Effect.tryPromise(() => agent.close()).pipe(Effect.ignore),
    );

    const sessionId = yield* Effect.acquireRelease(
      Effect.tryPromise(() => agent.createSession({ cwd: config.cwd })),
      (sessionId) => Effect.tryPromise(() => agent.closeSession(sessionId)).pipe(Effect.ignore),
    );

    const modelOption = yield* resolveModelOption(
      agent.configOptionsFor(sessionId),
      input.agent.provider,
      input.agent.model,
    );
    if (modelOption !== undefined) {
      yield* Effect.tryPromise(() =>
        agent.setConfigOption(sessionId, modelOption.configId, modelOption.value),
      );
    }
    const runTurn = (turn: {
      readonly prompt: string;
      readonly sequence: number;
    }): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        yield* emit({
          taskId: input.taskId,
          sequence: 0,
          timestamp: now(),
          type: "task:turn_started",
          payload: { prompt: turn.prompt, sequence: turn.sequence },
        });

        const agentStream = agent.prompt(sessionId, { prompt: turn.prompt });

        yield* Stream.fromAsyncIterable(agentStream, (error) => error).pipe(
          Stream.map((event) => makeEvent(input.taskId, event)),
          Stream.filter((event): event is TaskEvent => event !== undefined),
          Stream.runForEach((event) => emit(event).pipe(Effect.asVoid)),
        );

        const result = yield* Effect.tryPromise(() => agentStream.completion);
        yield* emit({
          taskId: input.taskId,
          sequence: 0,
          timestamp: now(),
          type: "task:turn_completed",
          payload: { text: result.text, sequence: turn.sequence },
        });
      });

    while (true) {
      const maybePrompt = yield* Queue.poll(input.userInbox);
      const turn = Option.isSome(maybePrompt)
        ? maybePrompt.value
        : yield* Effect.race(
            input.completionSignal.pipe(Effect.as(undefined)),
            Queue.take(input.userInbox),
          );

      if (turn === undefined) {
        const promptAfterCompletion = yield* Queue.poll(input.userInbox);
        if (Option.isNone(promptAfterCompletion)) {
          return;
        }
        yield* runTurn(promptAfterCompletion.value);
        continue;
      }

      yield* runTurn(turn);
    }
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => toRuntimeError(input, error, traceTail)),
  );
};

export const makeSpawnAgentRuntime = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* readRuntimeConfig;
  const deps = { fs, path, config } satisfies SpawnAgentRuntimeDeps;

  return {
    runAgent: (input, emit) => runAgentScoped(deps, input, emit),
  } satisfies AgentRuntime;
});

export const SpawnAgentRuntimeLive = Layer.effect(AgentRuntime, makeSpawnAgentRuntime);
