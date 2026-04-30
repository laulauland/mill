import * as FileSystem from "effect/FileSystem";
import { Cause, Data, Effect, Exit, Fiber, Queue, Ref, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import {
  ProgramHostProtocolPrefix,
  decodeProgramHostInboundMessage,
  type ProgramHostInboundMessage,
  type ProgramHostOutboundMessage,
  type ProgramHostResponseMessage,
} from "./program-host.schema";
import type { ProgramHostTaskCommand } from "./program-host.schema";
import { makeTaskActorRuntime, type TaskActorRuntime } from "./task-actor.effect";
import type { ExtensionRegistration, TaskInput, TaskResult } from "./types";

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
  readonly env?: Readonly<Record<string, string>>;
  readonly task: (input: TaskInput) => Effect.Effect<TaskResult, unknown>;
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

const basename = (path: string): string => {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");

  if (index < 0) {
    return normalized;
  }

  return normalized.slice(index + 1);
};

const isBunExecutable = (path: string): boolean => {
  const name = basename(path).toLowerCase();
  return name === "bun" || name.startsWith("bun-") || name.startsWith("bun.");
};

const resolveProgramHostExecutable = (): string =>
  isBunExecutable(process.execPath) ? process.execPath : "bun";

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

const splitProgramImports = (
  source: string,
): { readonly imports: ReadonlyArray<string>; readonly body: string } => {
  const imports: Array<string> = [];
  const body: Array<string> = [];

  for (const line of source.split("\n")) {
    if (line.trimStart().startsWith("import ")) {
      imports.push(line);
    } else {
      body.push(line);
    }
  }

  return {
    imports,
    body: body.join("\n"),
  };
};

const createProgramHostSource = (
  input: Pick<ExecuteProgramInProcessHostInput, "executorName" | "programSource" | "extensions">,
): string => {
  const extensionSpecs = JSON.stringify(buildExtensionSpecs(input.extensions));
  const protocolPrefix = JSON.stringify(ProgramHostProtocolPrefix);
  const executorName = JSON.stringify(input.executorName);
  const program = splitProgramImports(input.programSource);

  return [
    ...program.imports,
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
    "const __millTaskControllers = new Map();",
    "",
    "const __millPublishTaskSnapshot = (taskId, snapshot) => {",
    "  const controller = __millTaskControllers.get(taskId);",
    "  if (controller === undefined) return;",
    "  if (JSON.stringify(controller.snapshot) === JSON.stringify(snapshot)) return;",
    "  controller.snapshot = snapshot;",
    "  for (const listener of controller.listeners) listener(snapshot);",
    "  if (controller.terminal) return;",
    '  if (snapshot.status === "complete" && snapshot.result !== undefined) {',
    "    controller.terminal = true;",
    "    controller.resolveDone(snapshot.result);",
    "  }",
    '  if (snapshot.status === "cancelled" && snapshot.result !== undefined) {',
    "    controller.terminal = true;",
    "    controller.resolveDone(snapshot.result);",
    "  }",
    '  if (snapshot.status === "failed") {',
    "    controller.terminal = true;",
    '    controller.rejectDone(new Error(String(snapshot.error ?? "task failed")));',
    "  }",
    "};",
    "",
    "const __millResolveParentMessage = (message) => {",
    '  if (message.kind === "response") {',
    "    const pending = __millPending.get(message.requestId);",
    "    if (pending === undefined) return;",
    "    __millPending.delete(message.requestId);",
    "    if (message.ok === true) {",
    "      pending.resolve(message.value);",
    "      return;",
    "    }",
    '    pending.reject(new Error(String(message.message ?? "program host request failed")));',
    "    return;",
    "  }",
    "",
    '  if (message.kind === "task:snapshot") {',
    "    __millPublishTaskSnapshot(message.taskId, message.snapshot);",
    "    return;",
    "  }",
    "",
    '  if (message.kind === "task:done") {',
    "    const controller = __millTaskControllers.get(message.taskId);",
    "    if (controller === undefined || controller.terminal) return;",
    "    controller.terminal = true;",
    "    controller.resolveDone(message.result);",
    "    return;",
    "  }",
    "",
    '  if (message.kind === "task:error") {',
    "    const controller = __millTaskControllers.get(message.taskId);",
    "    if (controller === undefined || controller.terminal) return;",
    "    controller.terminal = true;",
    '    controller.rejectDone(new Error(String(message.message ?? "task failed")));',
    "  }",
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
    "      __millResolveParentMessage(JSON.parse(line));",
    "    } catch (_error) {",
    "      // Ignore malformed parent messages.",
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
    "const __millTaskSnapshot = (taskId, input, status, extra = {}) => ({",
    "  id: taskId,",
    "  runId: undefined,",
    '  ref: { runId: "program-host", taskId },',
    "  status,",
    "  input,",
    '  text: "",',
    '  thought: "",',
    "  queue: [],",
    "  ...extra,",
    "});",
    "",
    "const __millCreateTaskActor = (input) => {",
    "  __millRequestCounter += 1;",
    "  const taskId = `task_${__millRequestCounter}`;",
    "  const listeners = new Set();",
    '  let snapshot = __millTaskSnapshot(taskId, input, "idle");',
    "  let started = false;",
    "  let terminal = false;",
    "  let resolveDone;",
    "  let rejectDone;",
    "  const done = new Promise((resolve, reject) => {",
    "    resolveDone = resolve;",
    "    rejectDone = reject;",
    "  });",
    "  const controller = { listeners, snapshot, terminal, resolveDone, rejectDone };",
    "  __millTaskControllers.set(taskId, controller);",
    "  const publishLocal = (next) => __millPublishTaskSnapshot(taskId, next);",
    '  __millCallHost({ requestType: "task:create", taskId, input }).catch((error) => {',
    "    terminal = true;",
    '    publishLocal({ ...snapshot, status: "failed", error: error instanceof Error ? error.message : String(error) });',
    "    rejectDone(error);",
    "  });",
    "  const actor = {",
    "    id: taskId,",
    '    ref: { runId: "program-host", taskId },',
    "    done,",
    "    start: () => {",
    "      if (started || terminal) return actor;",
    "      started = true;",
    '      __millCallHost({ requestType: "task:start", taskId }).catch((error) => {',
    "        terminal = true;",
    '        publishLocal({ ...snapshot, status: "failed", error: error instanceof Error ? error.message : String(error) });',
    "        rejectDone(error);",
    "      });",
    "      return actor;",
    "    },",
    '    stop: () => actor.cancel("Task stopped"),',
    "    cancel: (reason) => {",
    "      if (terminal) return actor;",
    '      __millCallHost({ requestType: "task:cancel", taskId, reason }).catch((error) => {',
    "        terminal = true;",
    '        publishLocal({ ...snapshot, status: "failed", error: error instanceof Error ? error.message : String(error) });',
    "        rejectDone(error);",
    "      });",
    "      return actor;",
    "    },",
    "    send: (command) => {",
    "      if (terminal) return actor;",
    '      __millCallHost({ requestType: "task:send", taskId, command }).catch((error) => {',
    "        terminal = true;",
    '        publishLocal({ ...snapshot, status: "failed", error: error instanceof Error ? error.message : String(error) });',
    "        rejectDone(error);",
    "      });",
    "      return actor;",
    "    },",
    "    subscribe: (listener) => {",
    "      listeners.add(listener);",
    "      listener(controller.snapshot);",
    "      return { unsubscribe: () => listeners.delete(listener) };",
    "    },",
    "    getSnapshot: () => controller.snapshot,",
    "  };",
    "  return actor;",
    "};",
    "",
    "const __millApi = {",
    "  task: (input) => __millCreateTaskActor(input),",
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
    program.body,
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
    '    process.stdin.removeAllListeners("data");',
    "    process.stdin.pause();",
    '    if (typeof process.stdin.destroy === "function") {',
    "      process.stdin.destroy();",
    "    }",
    "  }",
    "};",
    "",
    "await __millRun();",
    "",
  ].join("\n");
};

const encodeOutbound = (message: ProgramHostOutboundMessage): Uint8Array =>
  textEncoder.encode(`${JSON.stringify(message)}\n`);

const sendOutbound = (
  queue: Queue.Queue<Uint8Array>,
  message: ProgramHostOutboundMessage,
): Effect.Effect<void> => Effect.asVoid(Queue.offer(queue, encodeOutbound(message)));

const sendResponse = (
  queue: Queue.Queue<Uint8Array>,
  response: ProgramHostResponseMessage,
): Effect.Effect<void> => sendOutbound(queue, response);

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

interface ProgramHostTaskActorState {
  readonly actor: TaskActorRuntime;
}

const taskNotFoundMessage = (taskId: string): string => `Unknown task actor ${taskId}`;

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

      const programHostExecutable = resolveProgramHostExecutable();
      const command = ChildProcess.make(programHostExecutable, ["run", hostProgramPath], {
        cwd: input.workingDirectory,
        env: input.env,
        extendEnv: input.env !== undefined && Object.keys(input.env).length > 0,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: false,
      });

      yield* Effect.logDebug("mill.program-host:start", {
        runId: input.runId,
        hostProgramPath,
        workingDirectory: input.workingDirectory,
        executable: programHostExecutable,
      });

      const processHandle = yield* Effect.mapError(
        command.asEffect(),
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
      const taskActorsRef = yield* Ref.make<ReadonlyMap<string, ProgramHostTaskActorState>>(
        new Map(),
      );

      const getTaskActor = (taskId: string): Effect.Effect<TaskActorRuntime, string> =>
        Effect.gen(function* () {
          const actors = yield* Ref.get(taskActorsRef);
          const state = actors.get(taskId);

          if (state === undefined) {
            return yield* Effect.fail(taskNotFoundMessage(taskId));
          }

          return state.actor;
        });

      const stdinFiber = yield* Effect.forkDetach(
        Stream.run(Stream.fromQueue(responseQueue), processHandle.stdin),
      );

      const stdoutFiber = yield* Effect.forkDetach(
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
            const decoded = yield* Effect.exit(decodeProgramHostInboundMessage(protocolPayload));

            if (Exit.isFailure(decoded)) {
              const message = summarizeCause(decoded.cause);
              yield* completeResult(protocolResultRef, {
                kind: "result",
                ok: false,
                message: `Malformed program host payload: ${message}`,
              });
              yield* Effect.logDebug("mill.program-host:malformed-payload", {
                runId: input.runId,
                message,
              });
              yield* Effect.ignore(processHandle.kill({ killSignal: "SIGTERM" }));
              return;
            }

            const message = decoded.value;

            if (message.kind === "result") {
              yield* completeResult(protocolResultRef, message);
              return;
            }

            if (message.requestType === "task:create") {
              const createExit = yield* Effect.exit(
                makeTaskActorRuntime(message.input, {
                  execute: input.task,
                  runId: input.runId,
                  taskId: message.taskId,
                }),
              );

              if (Exit.isFailure(createExit)) {
                yield* sendResponse(responseQueue, {
                  kind: "response",
                  requestId: message.requestId,
                  ok: false,
                  message: summarizeCause(createExit.cause),
                });
                return;
              }

              const actor = createExit.value;
              actor.subscribe((snapshot) => {
                if (snapshot.status === "idle") {
                  return;
                }

                Effect.runFork(
                  sendOutbound(responseQueue, {
                    kind: "task:snapshot",
                    taskId: actor.id,
                    snapshot,
                  }),
                );
              });
              yield* Effect.forkDetach(
                actor.done.pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      sendOutbound(responseQueue, {
                        kind: "task:error",
                        taskId: actor.id,
                        message: toMessage(error),
                      }),
                    onSuccess: (result) =>
                      sendOutbound(responseQueue, {
                        kind: "task:done",
                        taskId: actor.id,
                        result,
                      }),
                  }),
                ),
              );

              yield* Ref.update(taskActorsRef, (actors) => {
                const next = new Map(actors);
                next.set(message.taskId, { actor });
                return next;
              });
              yield* sendResponse(responseQueue, {
                kind: "response",
                requestId: message.requestId,
                ok: true,
                value: actor.getSnapshot(),
              });
              return;
            }

            if (message.requestType === "task:start") {
              const actorExit = yield* Effect.exit(getTaskActor(message.taskId));

              if (Exit.isFailure(actorExit)) {
                yield* sendResponse(responseQueue, {
                  kind: "response",
                  requestId: message.requestId,
                  ok: false,
                  message: summarizeCause(actorExit.cause),
                });
                return;
              }

              const startExit = yield* Effect.exit(actorExit.value.start);

              if (Exit.isFailure(startExit)) {
                yield* sendResponse(responseQueue, {
                  kind: "response",
                  requestId: message.requestId,
                  ok: false,
                  message: summarizeCause(startExit.cause),
                });
                return;
              }

              yield* sendResponse(responseQueue, {
                kind: "response",
                requestId: message.requestId,
                ok: true,
                value: actorExit.value.getSnapshot(),
              });
              return;
            }

            if (message.requestType === "task:send") {
              const actorExit = yield* Effect.exit(getTaskActor(message.taskId));

              if (Exit.isFailure(actorExit)) {
                yield* sendResponse(responseQueue, {
                  kind: "response",
                  requestId: message.requestId,
                  ok: false,
                  message: summarizeCause(actorExit.cause),
                });
                return;
              }

              const sendExit = yield* Effect.exit(
                actorExit.value.send(message.command as ProgramHostTaskCommand),
              );

              if (Exit.isFailure(sendExit)) {
                yield* sendResponse(responseQueue, {
                  kind: "response",
                  requestId: message.requestId,
                  ok: false,
                  message: summarizeCause(sendExit.cause),
                });
                return;
              }

              yield* sendResponse(responseQueue, {
                kind: "response",
                requestId: message.requestId,
                ok: true,
                value: actorExit.value.getSnapshot(),
              });
              return;
            }

            if (message.requestType === "task:cancel") {
              const actorExit = yield* Effect.exit(getTaskActor(message.taskId));

              if (Exit.isFailure(actorExit)) {
                yield* sendResponse(responseQueue, {
                  kind: "response",
                  requestId: message.requestId,
                  ok: false,
                  message: summarizeCause(actorExit.cause),
                });
                return;
              }

              const cancelExit = yield* Effect.exit(actorExit.value.cancel(message.reason));

              if (Exit.isFailure(cancelExit)) {
                yield* sendResponse(responseQueue, {
                  kind: "response",
                  requestId: message.requestId,
                  ok: false,
                  message: summarizeCause(cancelExit.cause),
                });
                return;
              }

              yield* sendResponse(responseQueue, {
                kind: "response",
                requestId: message.requestId,
                ok: true,
                value: actorExit.value.getSnapshot(),
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

      const stderrFiber = yield* Effect.forkDetach(
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

      const exitCodeExit = yield* Effect.exit(processHandle.exitCode);
      const exitCode = Exit.isSuccess(exitCodeExit) ? Number(exitCodeExit.value) : undefined;

      yield* Effect.logDebug("mill.program-host:exit", {
        runId: input.runId,
        pid: Number(processHandle.pid),
        exitCode: exitCode ?? "unknown",
      });

      yield* Queue.shutdown(responseQueue);
      yield* Fiber.await(stdinFiber);
      yield* Fiber.await(stdoutFiber);
      yield* Fiber.await(stderrFiber);

      const stderrLines = yield* Ref.get(stderrLinesRef);
      const protocolResult = yield* Ref.get(protocolResultRef);

      if (protocolResult === undefined) {
        const exitMessage = Exit.isFailure(exitCodeExit)
          ? summarizeCause(exitCodeExit.cause)
          : `exitCode=${exitCode}`;
        return yield* Effect.fail(
          new ProgramHostError({
            runId: input.runId,
            message: `Program host exited without result (${exitMessage}).${extensionMessage(
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

      if (exitCode !== undefined && exitCode !== 0) {
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
