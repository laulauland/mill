import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { runWithRuntime } from "./test-runtime";
import {
  decodeJsonRpcMessage,
  encodeJsonRpcNotification,
  encodeJsonRpcRequest,
  encodeJsonRpcResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./acp.codec";

describe("encodeJsonRpcRequest", () => {
  it("produces valid JSON-RPC request with trailing newline", async () => {
    const encoded = encodeJsonRpcRequest(1, "initialize", { foo: "bar" });

    expect(encoded.endsWith("\n")).toBe(true);

    const decoded = (await runWithRuntime(decodeJsonRpcMessage(encoded))) as JsonRpcRequest;

    expect(decoded.jsonrpc).toBe("2.0");
    expect(decoded.id).toBe(1);
    expect(decoded.method).toBe("initialize");
    expect(decoded.params).toEqual({ foo: "bar" });
  });
});

describe("encodeJsonRpcNotification", () => {
  it("produces valid JSON-RPC notification with trailing newline", async () => {
    const encoded = encodeJsonRpcNotification("session/update", { text: "hello" });

    expect(encoded.endsWith("\n")).toBe(true);

    const decoded = (await runWithRuntime(decodeJsonRpcMessage(encoded))) as JsonRpcNotification;

    expect(decoded.jsonrpc).toBe("2.0");
    expect(decoded.method).toBe("session/update");
    expect(decoded.params).toEqual({ text: "hello" });
    expect("id" in decoded).toBe(false);
  });
});

describe("encodeJsonRpcResponse", () => {
  it("produces valid JSON-RPC response with trailing newline", async () => {
    const encoded = encodeJsonRpcResponse(5, { ok: true });

    expect(encoded.endsWith("\n")).toBe(true);

    const decoded = (await runWithRuntime(decodeJsonRpcMessage(encoded))) as JsonRpcResponse;

    expect(decoded.jsonrpc).toBe("2.0");
    expect(decoded.id).toBe(5);
    expect(decoded.result).toEqual({ ok: true });
  });
});

describe("decodeJsonRpcMessage", () => {
  it("correctly identifies a response (has id, no method)", async () => {
    const encoded = encodeJsonRpcResponse(1, { ok: true });
    const message = await runWithRuntime(decodeJsonRpcMessage(encoded));

    expect("id" in message).toBe(true);
    expect("method" in message).toBe(false);
    expect((message as JsonRpcResponse).id).toBe(1);
    expect((message as JsonRpcResponse).result).toEqual({ ok: true });
  });

  it("correctly identifies a request (has id and method)", async () => {
    const encoded = encodeJsonRpcRequest(2, "initialize", {});
    const message = await runWithRuntime(decodeJsonRpcMessage(encoded));

    expect("id" in message).toBe(true);
    expect("method" in message).toBe(true);
    expect((message as JsonRpcRequest).id).toBe(2);
    expect((message as JsonRpcRequest).method).toBe("initialize");
  });

  it("correctly identifies a notification (has method, no id)", async () => {
    const encoded = encodeJsonRpcNotification("session/update", { text: "hi" });
    const message = await runWithRuntime(decodeJsonRpcMessage(encoded));

    expect("method" in message).toBe(true);
    expect("id" in message).toBe(false);
    expect((message as JsonRpcNotification).method).toBe("session/update");
  });

  it("fails on invalid JSON", async () => {
    const result = await runWithRuntime(Effect.either(decodeJsonRpcMessage("not-json{")));

    expect(result._tag).toBe("Left");
  });

  it("fails on missing jsonrpc field", async () => {
    const result = await runWithRuntime(
      Effect.either(decodeJsonRpcMessage('{"id": 1, "method": "test"}')),
    );

    expect(result._tag).toBe("Left");
  });

  it("fails on empty line", async () => {
    const result = await runWithRuntime(Effect.either(decodeJsonRpcMessage("")));

    expect(result._tag).toBe("Left");
  });
});
