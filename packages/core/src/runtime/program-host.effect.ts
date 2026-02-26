import * as Command from "@effect/platform/Command";
import * as FileSystem from "@effect/platform/FileSystem";
import { Cause, Data, Effect, Exit, Fiber, Queue, Ref, Stream } from "effect";
import {
  ProgramHostProtocolPrefix,
  decodeProgramHostInboundMessage,
  type ProgramHostInboundMessage,
  type ProgramHostResponseMessage,
} from "../domain/program-host.schema";
import type { SpawnOptions, SpawnResult } from "../domain/spawn.schema";
import type { ExtensionRegistration } from "../public/types";

export class ProgramHostError extends Data.TaggedError("ProgramHostError")<{
  runId: string;
  message: string;
}> {}

export interface ExecuteProgramInProcessHostInput {
  readonly runId: string;
  readonly runDirectory: string;
  readonly workingDirectory: string;
  readonly programPath: string;
  readonly programSource: string;
  readonly executorName: string;
  readonly extensions: ReadonlyArray<ExtensionRegistration>;
  readonly spawn: (input: SpawnOptions) => Effect.Effect<SpawnResult, unknown>;
  readonly onIo?: (input: {
    readonly stream: "stdout" | "stderr";
    readonly line: string;
  }) => Effect.Effect<void>;
}

type ProgramHostResultMessage = Extract<ProgramHostInboundMessage, { readonly kind: "result" }>;

type ExtensionApiMethod = (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>;

const textEncoder = new TextEncoder();

const normalizePath = (path: string): string => {
  if (path.length <= 1) {
    return path;
  }

  return path.endsWith("/") ? path.slice(0, -1) : path;
};

const joinPath = (base: string, child: string): string =>
  normalizePath(base) === "/" ? `/${child}` : `${normalizePath(base)}/${child}`;

const toMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const buildExtensionApiLookup = (
  extensions: ReadonlyArray<ExtensionRegistration>,
): ReadonlyMap<string, Readonly<Record<string, ExtensionApiMethod>>> =>
  new Map(
    extensions
      .filter((extension) => extension.api !== undefined)
      .map(
        (extension) =>
          [extension.name, extension.api as Readonly<Record<string, ExtensionApiMethod>>] as const,
      ),
  );

const buildExtensionSpecs = (extensions: ReadonlyArray<ExtensionRegistration>) =>
  extensions
    .filter((extension) => extension.api !== undefined)
    .map((extension) => ({
      name: extension.name,
      methods: Object.keys(extension.api ?? {}),
    }));

const createProgramHostSource = (
  input: Pick<ExecuteProgramInProcessHostInput, "executorName" | "programSource" | "extensions">,
): string => {
  const extensionSpecs = JSON.stringify(buildExtensionSpecs(input.extensions));
  const protocolPrefix = JSON.stringify(ProgramHostProtocolPrefix);
  const executorName = JSON.stringify(input.executorName);

  return [
    `const __millProtocolPrefix = ${protocolPrefix};`,
    `const __millExecutorName = ${executorName};`,
    `const __millExtensionSpecs = ${extensionSpecs};`,
    "globalThis.__millExecutorName = __millExecutorName;",
    "",
    "const __millPending = new Map();",
    "let __millRequestCounter = 0;",
    'let __millStdinBuffer = "";',
    "",
    "const __millSend = (message) => {",
    '  process.stdout.write(__millProtocolPrefix + JSON.stringify(message) + "\\n");',
    "};",
    "",
    "const __millResolveResponse = (message) => {",
    '  if (message.kind !== "response") {',
    "    return;",
    "  }",
    "",
    "  const pending = __millPending.get(message.requestId);",
    "",
    "  if (pending === undefined) {",
    "    return;",
    "  }",
    "",
    "  __millPending.delete(message.requestId);",
    "",
    "  if (message.ok === true) {",
    "    pending.resolve(message.value);",
    "    return;",
    "  }",
    "",
    '  pending.reject(new Error(String(message.message ?? "program host request failed")));',
    "};",
    "",
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => {',
    "  __millStdinBuffer += chunk;",
    "",
    "  while (true) {",
    '    const newlineIndex = __millStdinBuffer.indexOf("\\n");',
    "",
    "    if (newlineIndex < 0) {",
    "      break;",
    "    }",
    "",
    "    const line = __millStdinBuffer.slice(0, newlineIndex).trim();",
    "    __millStdinBuffer = __millStdinBuffer.slice(newlineIndex + 1);",
    "",
    "    if (line.length === 0) {",
    "      continue;",
    "    }",
    "",
    "    try {",
    "      __millResolveResponse(JSON.parse(line));",
    "    } catch (_error) {",
    "      // Ignore malformed parent responses.",
    "    }",
    "  }",
    "});",
    "",
    "const __millCallHost = (request) =>",
    "  new Promise((resolve, reject) => {",
    "    __millRequestCounter += 1;",
    "    const requestId = `req_${__millRequestCounter}`;",
    "",
    "    __millPending.set(requestId, { resolve, reject });",
    "    __millSend({",
    '      kind: "request",',
    "      requestId,",
    "      ...request,",
    "    });",
    "  });",
    "",
    "const __millApi = {",
    "  spawn: (input) =>",
    "    __millCallHost({",
    '      requestType: "spawn",',
    "      input,",
    "    }),",
    "};",
    "",
    "for (const extension of __millExtensionSpecs) {",
    "  const extensionApi = {};",
    "",
    "  for (const methodName of extension.methods) {",
    "    extensionApi[methodName] = (...args) =>",
    "      __millCallHost({",
    '        requestType: "extension",',
    "        extensionName: extension.name,",
    "        methodName,",
    "        args,",
    "      });",
    "  }",
    "",
    "  __millApi[extension.name] = extensionApi;",
    "}",
    "",
    "globalThis.mill = __millApi;",
    "",
    "const __millProgram = async () => {",
    input.programSource,
    "};",
    "",
    "const __millRun = async () => {",
    "  try {",
    "    const value = await __millProgram();",
    "",
    "    __millSend({",
    '      kind: "result",',
    "      ok: true,",
    "      value,",
    "    });",
    "  } catch (error) {",
    "    __millSend({",
    '      kind: "result",',
    "      ok: false,",
    "      message: error instanceof Error ? error.message : String(error),",
    "    });",
    "  } finally {",
    "    process.stdin.pause();",
    "  }",
    "};",
    "",
    "await __millRun();",
    "",
  ].join("\n");
};

const encodeResponse = (response: ProgramHostResponseMessage): Uint8Array =>
  textEncoder.encode(`${JSON.stringify(response)}\n`);

const sendResponse = (
  queue: Queue.Queue<Uint8Array>,
  response: ProgramHostResponseMessage,
): Effect.Effect<void> => Effect.asVoid(Queue.offer(queue, encodeResponse(response)));

const summarizeCause = (cause: Exit.Exit<unknown, unknown>["cause"]): string => Cause.pretty(cause);

const extensionMessage = (stderrLines: ReadonlyArray<string>): string => {
  if (stderrLines.length === 0) {
    return "";
  }

  return `\nstderr:\n${stderrLines.join("\n")}`;
};

const completeResult = (
  resultRef: Ref.Ref<ProgramHostResultMessage | undefined>,
  result: ProgramHostResultMessage,
): Effect.Effect<void> =>
  Ref.update(resultRef, (current) => {
    if (current !== undefined) {
      return current;
    }

    return result;
  });

export const executeProgramInProcessHost = (
  input: ExecuteProgramInProcessHostInput,
): Effect.Effect<unknown, ProgramHostError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const runDirectory = normalizePath(input.runDirectory);
      const markerPath = joinPath(runDirectory, "program-host.marker");
      const hostProgramPath = joinPath(runDirectory, "program-host.ts");
      const extensionLookup = buildExtensionApiLookup(input.extensions);
      const protocolResultRef = yield* Ref.make<ProgramHostResultMessage | undefined>(undefined);
      const stderrLinesRef = yield* Ref.make<ReadonlyArray<string>>([]);

      yield* Effect.mapError(
        fileSystem.makeDirectory(runDirectory, { recursive: true }),
        (error) =>
          new ProgramHostError({
            runId: input.runId,
            message: `Unable to ensure run directory ${runDirectory}: ${toMessage(error)}`,
          }),
      );

      yield* Effect.mapError(
        fileSystem.writeFileString(
          markerPath,
          [
            "process-host:bun",
            `runId=${input.runId}`,
            `executor=${input.executorName}`,
            `programPath=${input.programPath}`,
          ].join("\n"),
        ),
        (error) =>
          new ProgramHostError({
            runId: input.runId,
            message: `Unable to write program host marker: ${toMessage(error)}`,
          }),
      );

      yield* Effect.mapError(
        fileSystem.writeFileString(hostProgramPath, createProgramHostSource(input)),
        (error) =>
          new ProgramHostError({
            runId: input.runId,
            message: `Unable to write program host script: ${toMessage(error)}`,
          }),
      );

      const command = Command.make(process.execPath, "run", hostProgramPath).pipe(
        Command.workingDirectory(input.workingDirectory),
        Command.stdin("pipe"),
        Command.stdout("pipe"),
        Command.stderr("pipe"),
      );

      yield* Effect.logDebug("mill.program-host:start", {
        runId: input.runId,
        hostProgramPath,
        workingDirectory: input.workingDirectory,
      });

      const processHandle = yield* Effect.mapError(
        Command.start(command),
        (error) =>
          new ProgramHostError({
            runId: input.runId,
            message: `Unable to start Bun program host: ${toMessage(error)}`,
          }),
      );

      yield* Effect.logDebug("mill.program-host:started", {
        runId: input.runId,
        pid: Number(processHandle.pid),
      });

      const responseQueue = yield* Queue.unbounded<Uint8Array>();

      const stdinFiber = yield* Effect.forkScoped(
        Stream.run(Stream.fromQueue(responseQueue, { shutdown: true }), processHandle.stdin),
      );

      const stdoutFiber = yield* Effect.forkScoped(
        Stream.runForEach(Stream.splitLines(Stream.decodeText(processHandle.stdout)), (line) =>
          Effect.gen(function* () {
            if (!line.startsWith(ProgramHostProtocolPrefix)) {
              if (line.length > 0 && input.onIo !== undefined) {
                yield* input.onIo({
                  stream: "stdout",
                  line,
                });
              }
              return;
            }

            const protocolPayload = line.slice(ProgramHostProtocolPrefix.length);
            const decoded = yield* Effect.either(decodeProgramHostInboundMessage(protocolPayload));

            if (decoded._tag === "Left") {
              yield* completeResult(protocolResultRef, {
                kind: "result",
                ok: false,
                message: `Malformed program host payload: ${toMessage(decoded.left)}`,
              });
              yield* Effect.logDebug("mill.program-host:malformed-payload", {
                runId: input.runId,
                message: toMessage(decoded.left),
              });
              yield* Effect.ignore(processHandle.kill("SIGTERM"));
              return;
            }

            const message = decoded.right;

            if (message.kind === "result") {
              yield* completeResult(protocolResultRef, message);
              return;
            }

            if (message.requestType === "spawn") {
              const spawnExit = yield* Effect.exit(input.spawn(message.input));

              if (Exit.isSuccess(spawnExit)) {
                yield* sendResponse(responseQueue, {
                  kind: "response",
                  requestId: message.requestId,
                  ok: true,
                  value: spawnExit.value,
                });
                return;
              }

              yield* sendResponse(responseQueue, {
                kind: "response",
                requestId: message.requestId,
                ok: false,
                message: summarizeCause(spawnExit.cause),
              });
              return;
            }

            const extensionApi = extensionLookup.get(message.extensionName);
            const method = extensionApi?.[message.methodName];

            if (method === undefined) {
              yield* sendResponse(responseQueue, {
                kind: "response",
                requestId: message.requestId,
                ok: false,
                message: `Unknown extension api ${message.extensionName}.${message.methodName}`,
              });
              return;
            }

            const methodExit = yield* Effect.exit(method(...message.args));

            if (Exit.isSuccess(methodExit)) {
              yield* sendResponse(responseQueue, {
                kind: "response",
                requestId: message.requestId,
                ok: true,
                value: methodExit.value,
              });
              return;
            }

            yield* sendResponse(responseQueue, {
              kind: "response",
              requestId: message.requestId,
              ok: false,
              message: summarizeCause(methodExit.cause),
            });
          }),
        ),
      );

      const stderrFiber = yield* Effect.forkScoped(
        Stream.runForEach(Stream.splitLines(Stream.decodeText(processHandle.stderr)), (line) =>
          Effect.gen(function* () {
            yield* Ref.update(stderrLinesRef, (lines) => [...lines, line]);

            if (line.length > 0 && input.onIo !== undefined) {
              yield* input.onIo({
                stream: "stderr",
                line,
              });
            }
          }),
        ),
      );

      const exitCode = yield* Effect.mapError(
        processHandle.exitCode,
        (error) =>
          new ProgramHostError({
            runId: input.runId,
            message: `Program host process failed before completion: ${toMessage(error)}`,
          }),
      );

      yield* Effect.logDebug("mill.program-host:exit", {
        runId: input.runId,
        pid: Number(processHandle.pid),
        exitCode,
      });

      yield* Queue.shutdown(responseQueue);
      yield* Effect.ignore(Fiber.join(stdinFiber));

      yield* Effect.mapError(
        Fiber.join(stdoutFiber),
        (error) =>
          new ProgramHostError({
            runId: input.runId,
            message: `Program host stdout processing failed: ${toMessage(error)}`,
          }),
      );

      yield* Effect.mapError(
        Fiber.join(stderrFiber),
        (error) =>
          new ProgramHostError({
            runId: input.runId,
            message: `Program host stderr processing failed: ${toMessage(error)}`,
          }),
      );

      const stderrLines = yield* Ref.get(stderrLinesRef);
      const protocolResult = yield* Ref.get(protocolResultRef);

      if (protocolResult === undefined) {
        return yield* Effect.fail(
          new ProgramHostError({
            runId: input.runId,
            message: `Program host exited without result (exitCode=${exitCode}).${extensionMessage(
              stderrLines,
            )}`,
          }),
        );
      }

      if (protocolResult.ok === false) {
        return yield* Effect.fail(
          new ProgramHostError({
            runId: input.runId,
            message: `${protocolResult.message}${extensionMessage(stderrLines)}`,
          }),
        );
      }

      if (exitCode !== 0) {
        return yield* Effect.fail(
          new ProgramHostError({
            runId: input.runId,
            message: `Program host exited with code ${exitCode}.${extensionMessage(stderrLines)}`,
          }),
        );
      }

      return protocolResult.value;
    }),
  );
