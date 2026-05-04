import { Context, Data, Effect, Layer, Queue } from "effect";
import type { Agent } from "../program.api";
import type { TaskEvent } from "../schemas/task-event";

export class AgentRuntimeError extends Data.TaggedError("AgentRuntimeError")<{
  readonly provider: string;
  readonly model: string;
  readonly message: string;
}> {}

export type TurnPrompt = {
  readonly prompt: string;
  readonly sequence: number;
};

export type AgentRuntimeInput = {
  readonly taskId: string;
  readonly agent: Agent;
  readonly userInbox: Queue.Queue<TurnPrompt>;
  readonly completionSignal: Effect.Effect<void>;
};

export type AgentRuntimeEmit = (event: TaskEvent) => Effect.Effect<void, unknown>;

export type AgentRuntime = {
  readonly runAgent: (
    input: AgentRuntimeInput,
    emit: AgentRuntimeEmit,
  ) => Effect.Effect<void, AgentRuntimeError>;
};

const now = (): string => new Date().toISOString();

export const AgentRuntime = Context.Service<AgentRuntime>("@mill/core/AgentRuntime");

export const makeStubAgentRuntime = Effect.sync(
  () =>
    ({
      runAgent: (input, emit) =>
        Effect.gen(function* () {
          while (true) {
            const maybePrompt = yield* Queue.poll(input.userInbox);
            const turn =
              maybePrompt._tag === "Some"
                ? maybePrompt.value
                : yield* Effect.race(
                    input.completionSignal.pipe(Effect.as(undefined)),
                    Queue.take(input.userInbox),
                  );

            if (turn === undefined) {
              const promptAfterCompletion = yield* Queue.poll(input.userInbox);
              if (promptAfterCompletion._tag === "None") {
                return;
              }
              const bufferedTurn = promptAfterCompletion.value;
              yield* emit({
                taskId: input.taskId,
                sequence: 0,
                timestamp: now(),
                type: "task:turn_started",
                payload: { prompt: bufferedTurn.prompt, sequence: bufferedTurn.sequence },
              }).pipe(Effect.catch(() => Effect.void));
              const text = `${input.agent.provider}:${input.agent.model} ${bufferedTurn.prompt}`;
              yield* emit({
                taskId: input.taskId,
                sequence: 0,
                timestamp: now(),
                type: "task:message_chunk",
                payload: { text },
              }).pipe(Effect.catch(() => Effect.void));
              yield* emit({
                taskId: input.taskId,
                sequence: 0,
                timestamp: now(),
                type: "task:turn_completed",
                payload: { text, sequence: bufferedTurn.sequence },
              }).pipe(Effect.catch(() => Effect.void));
              continue;
            }

            yield* emit({
              taskId: input.taskId,
              sequence: 0,
              timestamp: now(),
              type: "task:turn_started",
              payload: { prompt: turn.prompt, sequence: turn.sequence },
            }).pipe(Effect.catch(() => Effect.void));
            const text = `${input.agent.provider}:${input.agent.model} ${turn.prompt}`;
            yield* emit({
              taskId: input.taskId,
              sequence: 0,
              timestamp: now(),
              type: "task:message_chunk",
              payload: { text },
            }).pipe(Effect.catch(() => Effect.void));
            yield* emit({
              taskId: input.taskId,
              sequence: 0,
              timestamp: now(),
              type: "task:turn_completed",
              payload: { text, sequence: turn.sequence },
            }).pipe(Effect.catch(() => Effect.void));
          }
        }),
    }) satisfies AgentRuntime,
);

export const AgentRuntimeStub = Layer.effect(AgentRuntime, makeStubAgentRuntime);
