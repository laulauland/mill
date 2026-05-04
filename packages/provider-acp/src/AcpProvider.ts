import { Context, Data, Effect, Layer, Option } from "effect";
import * as Schema from "effect/Schema";
import { Scope } from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { TaskEvent } from "@mill/core";
import { AcpSession, makeAcpSession } from "./AcpSession";

export class AcpProviderError extends Data.TaggedError("AcpProviderError")<{
  readonly providerName: string;
  readonly message: string;
}> {}

export interface AcpProvider {
  readonly name: string;
  readonly createSession: (
    taskId: string,
  ) => Effect.Effect<AcpSession, AcpProviderError, ChildProcessSpawner | Scope>;
  readonly mapToTaskEvent: (message: unknown, taskId: string, sequence: number) => TaskEvent;
}

export interface AcpProviderConfig {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

const now = (): string => new Date().toISOString();

const ProviderMessage = Schema.Struct({
  type: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
});

export const makeAcpProvider = (config: AcpProviderConfig) =>
  Effect.sync(() => {
    const createSession = (taskId: string) =>
      makeAcpSession({
        sessionId: taskId,
        command: config.command,
        args: config.args,
        env: config.env,
      }).pipe(
        Effect.catch((error: { message: string }) =>
          Effect.fail(
            new AcpProviderError({
              providerName: config.name,
              message: `Failed to create session: ${error.message}`,
            }),
          ),
        ),
      );

    const mapToTaskEvent = (message: unknown, taskId: string, sequence: number): TaskEvent => {
      const msg = typeof message === "string" ? { type: "text", content: message } : (message as { type?: string; content?: string });
      const timestamp = now();

      switch (msg.type) {
        case "tool_call":
          return {
            taskId,
            sequence,
            timestamp,
            type: "task:tool_called",
            payload: { toolName: msg.content ?? "unknown", arguments: {} },
          };
        case "tool_result":
          return {
            taskId,
            sequence,
            timestamp,
            type: "task:tool_returned",
            payload: { toolName: msg.content ?? "unknown", result: "" },
          };
        case "error":
          return {
            taskId,
            sequence,
            timestamp,
            type: "task:failed",
            payload: { error: msg.content ?? "Unknown error" },
          };
        default:
          return {
            taskId,
            sequence,
            timestamp,
            type: "task:message_chunk",
            payload: { text: msg.content ?? String(message) },
          };
      }
    };

    return {
      name: config.name,
      createSession,
      mapToTaskEvent,
    } satisfies AcpProvider;
  });

export const AcpProvider = Context.Service<AcpProvider>("@mill/provider-acp/AcpProvider");

export const AcpProviderLive = (config: AcpProviderConfig) =>
  Layer.effect(AcpProvider, () => makeAcpProvider(config));
