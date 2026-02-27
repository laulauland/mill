import { Data, Effect } from "effect";

// --- JSON-RPC 2.0 message types ---

export type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
};

export type JsonRpcResponse = {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
};

export type JsonRpcNotification = {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export class JsonRpcDecodeError extends Data.TaggedError("JsonRpcDecodeError")<{
  message: string;
  raw: string;
}> {}

// --- ACP session update types ---

export type AcpSessionUpdateType =
  | "agent_message_chunk"
  | "agent_thought_chunk"
  | "tool_call"
  | "tool_call_update"
  | "plan"
  | "available_commands_update"
  | "current_mode_update"
  | "config_option_update";

export type AcpSessionUpdate = {
  readonly sessionUpdate: AcpSessionUpdateType;
  readonly sessionId: string;
  readonly [key: string]: unknown;
};

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export type AcpPromptResponse = {
  readonly stopReason: AcpStopReason;
};

export type AcpInitializeResult = {
  readonly protocolVersion: string;
  readonly serverInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly capabilities?: unknown;
};

export type AcpNewSessionResult = {
  readonly sessionId: string;
};

// --- Codec functions ---

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonRpcResponse = (message: Record<string, unknown>): boolean =>
  message.jsonrpc === "2.0" && typeof message.id === "number" && !("method" in message);

const isJsonRpcRequest = (message: Record<string, unknown>): boolean =>
  message.jsonrpc === "2.0" && typeof message.id === "number" && typeof message.method === "string";

const isJsonRpcNotification = (message: Record<string, unknown>): boolean =>
  message.jsonrpc === "2.0" && typeof message.method === "string" && !("id" in message);

export const encodeJsonRpcRequest = (id: number, method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

export const encodeJsonRpcNotification = (method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";

export const encodeJsonRpcResponse = (id: number, result: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";

const toJsonRpcResponse = (parsed: Record<string, unknown>): JsonRpcResponse => {
  const error = parsed.error as JsonRpcResponse["error"];
  return {
    jsonrpc: "2.0",
    id: parsed.id as number,
    result: parsed.result,
    error,
  };
};

const toJsonRpcRequest = (parsed: Record<string, unknown>): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id: parsed.id as number,
  method: parsed.method as string,
  params: parsed.params,
});

const toJsonRpcNotification = (parsed: Record<string, unknown>): JsonRpcNotification => ({
  jsonrpc: "2.0",
  method: parsed.method as string,
  params: parsed.params,
});

export const decodeJsonRpcMessage = (
  line: string,
): Effect.Effect<JsonRpcMessage, JsonRpcDecodeError> =>
  Effect.gen(function* () {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      return yield* Effect.fail(new JsonRpcDecodeError({ message: "Empty line", raw: line }));
    }

    const parsed = yield* Effect.mapError(
      Effect.try(() => JSON.parse(trimmed) as unknown),
      (error) =>
        new JsonRpcDecodeError({
          message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          raw: line,
        }),
    );

    if (!isRecord(parsed)) {
      return yield* Effect.fail(
        new JsonRpcDecodeError({ message: "Parsed value is not an object", raw: line }),
      );
    }

    if (parsed.jsonrpc !== "2.0") {
      return yield* Effect.fail(
        new JsonRpcDecodeError({ message: "Missing or invalid jsonrpc field", raw: line }),
      );
    }

    if (isJsonRpcResponse(parsed)) {
      return toJsonRpcResponse(parsed);
    }

    if (isJsonRpcRequest(parsed)) {
      return toJsonRpcRequest(parsed);
    }

    if (isJsonRpcNotification(parsed)) {
      return toJsonRpcNotification(parsed);
    }

    return yield* Effect.fail(
      new JsonRpcDecodeError({ message: "Unrecognized JSON-RPC message shape", raw: line }),
    );
  });
