import {
  currentWorkingDirectory,
  fileURLToPath,
  homeDirectory,
  nodeExecutablePath,
  path,
  temporaryDirectory,
} from "./platform.adapter.js";
import { spawn as spawnProcess } from "node:child_process";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as FileSystem from "effect/FileSystem";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Config, ConfigProvider, Effect, Exit, Option } from "effect";
import { parseJson } from "./json.codec.js";
import { MillError } from "./errors.js";
import type { ObservabilityStore } from "./observability.js";
import type { ExecutionResult } from "./types.js";

const readOptionalConfigString = (name: string): string | undefined =>
  Effect.runSync(
    Effect.map(
      Config.string(name).pipe(Config.option).parse(ConfigProvider.fromEnv()),
      Option.getOrUndefined,
    ),
  );

const provideFileSystem = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  effect.pipe(Effect.provide(BunFileSystem.layer));

const appendTextFileEffect = (filePath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(filePath, content, { flag: "a" });
  });

const writeTextFileEffect = (filePath: string, content: string, mode?: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(filePath, content, mode === undefined ? undefined : { mode });
  });

const copyFileEffect = (source: string, target: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.copyFile(source, target);
  });

const makeTemporaryDirectoryEffect = (prefixPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectory({
      directory: path.dirname(prefixPath),
      prefix: path.basename(prefixPath),
    });
  });

const pathExistsEffect = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(filePath);
  });

const ensureDirectoryEffect = (dirPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirPath, { recursive: true });
  });

const removePathEffect = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(filePath, { recursive: true, force: true });
  });

// ── Branded task actors/promises ───────────────────────────────────────

export const TASK_BRAND = Symbol.for("pi-mill:task");

// ── Console patching — route program logs to observability ──────────────

export function patchConsole(obs: ObservabilityStore, runId: string): () => void {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const format = (...args: unknown[]) =>
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");

  console.log = (...args: unknown[]) => obs.push(runId, "info", `console: ${format(...args)}`);
  console.warn = (...args: unknown[]) => obs.push(runId, "warning", `console: ${format(...args)}`);
  console.error = (...args: unknown[]) => obs.push(runId, "error", `console: ${format(...args)}`);

  return () => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  };
}

// ── Promise.all / Promise.allSettled patching for observability ─────────

export function patchPromiseAll(obs: ObservabilityStore, runId: string): () => void {
  const originalAll = Promise.all.bind(Promise);
  const originalAllSettled = Promise.allSettled.bind(Promise);
  let groupCounter = 0;

  Promise.all = function <T>(iterable: Iterable<T>): Promise<Awaited<T>[]> {
    const items = Array.from(iterable);
    const tasks = items.filter(
      (item): item is any =>
        item != null && typeof item === "object" && (item as any)[TASK_BRAND] === true,
    );
    if (tasks.length > 0) {
      groupCounter++;
      const groupId = `group-${groupCounter}`;
      obs.push(runId, "info", "group:start", {
        groupId,
        count: tasks.length,
        tasks: tasks.map((s: any) => s.taskId),
      });
      const result = originalAll(items);
      void Effect.runPromise(
        Effect.promise(() => result).pipe(
          Effect.match({
            onFailure: () =>
              obs.push(runId, "info", "group:failed", { groupId, count: tasks.length }),
            onSuccess: () =>
              obs.push(runId, "info", "group:done", { groupId, count: tasks.length }),
          }),
        ),
      );
      return result;
    }
    return originalAll(items);
  } as typeof Promise.all;

  Promise.allSettled = function <T>(
    iterable: Iterable<T>,
  ): Promise<PromiseSettledResult<Awaited<T>>[]> {
    const items = Array.from(iterable);
    const tasks = items.filter(
      (item): item is any =>
        item != null && typeof item === "object" && (item as any)[TASK_BRAND] === true,
    );
    if (tasks.length > 0) {
      groupCounter++;
      const groupId = `group-settled-${groupCounter}`;
      obs.push(runId, "info", "group:start", {
        groupId,
        count: tasks.length,
        tasks: tasks.map((s: any) => s.taskId),
        settled: true,
      });
      const result = originalAllSettled(items);
      void Effect.runPromise(
        Effect.promise(() => result).pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              obs.push(runId, "info", "group:done", { groupId, count: tasks.length }),
            ),
          ),
        ),
      );
      return result;
    }
    return originalAllSettled(items);
  } as typeof Promise.allSettled;

  return () => {
    Promise.all = originalAll;
    Promise.allSettled = originalAllSettled;
  };
}

// ── Single subagent task (via mill) ────────────────────────────────────

interface SubagentTaskInput {
  runId: string;
  taskId: string;
  agent: string;
  system: string;
  prompt: string;
  cwd: string;
  modelId: string;
  tools: string[];
  step?: number;
  signal?: AbortSignal;
  obs: ObservabilityStore;
  onProgress?: (result: ExecutionResult) => void;
  onSubmittedRunId?: (runId: string, taskId: string) => void;
  parentSessionPath?: string;
  piSessionKey?: string;
  sessionDir?: string;
  millCommand: string;
  millArgs: string[];
  millRunsDir?: string;
}

interface MillTaskResult {
  text?: string;
  sessionRef?: string;
  role?: string;
  model?: string;
  driver?: string;
  exitCode?: number;
  stopReason?: string;
  errorMessage?: string;
}

interface MillRunSubmitPayload {
  runId?: string;
}

interface MillWatchOutputEnvelope {
  kind?: string;
  runId?: string;
  event?: {
    type?: string;
    payload?: Record<string, unknown>;
  };
}

interface CommandCapture {
  code: number;
  stdout: string;
  stderr: string;
  combined: string;
  aborted: boolean;
}

const raise = <A>(error: unknown): A => Effect.runSync(Effect.fail(error));

function newUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

const parseJsonObjectFromText = (text: string): Record<string, unknown> | undefined => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reverse();

  for (const line of lines) {
    const parsed = Effect.runSyncExit(Effect.try(() => parseJson(line)));
    if (Exit.isSuccess(parsed) && typeof parsed.value === "object" && parsed.value !== null) {
      return parsed.value as Record<string, unknown>;
    }
  }

  return undefined;
};

const parseJsonObjectsFromText = (text: string): Array<Record<string, unknown>> =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const parsed = Effect.runSyncExit(Effect.try(() => parseJson(line)));
      return Exit.isSuccess(parsed) && typeof parsed.value === "object" && parsed.value !== null
        ? [parsed.value as Record<string, unknown>]
        : [];
    });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readStringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const formatCommand = (command: string, args: ReadonlyArray<string>): string =>
  [command, ...args].join(" ");

const appendCommandLogEffect = (
  logPath: string,
  command: string,
  args: ReadonlyArray<string>,
  output: CommandCapture,
): Effect.Effect<void, unknown, FileSystem.FileSystem> => {
  const header = [
    `> ${formatCommand(command, args)}`,
    `exit=${output.code}${output.aborted ? " (aborted)" : ""}`,
  ].join("\n");
  const body = output.combined.trim();
  const chunk = `${header}${body.length > 0 ? `\n${body}` : ""}\n\n`;
  return appendTextFileEffect(logPath, chunk);
};

const runCommandCapture = (input: {
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
}): Promise<CommandCapture> => {
  const deferred = Promise.withResolvers<CommandCapture>();
  const resolve = deferred.resolve;

  let stdout = "";
  let stderr = "";
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let aborted = input.signal?.aborted ?? false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const flushLines = (which: "stdout" | "stderr") => {
    let buffer = which === "stdout" ? stdoutBuffer : stderrBuffer;
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) input.onLine?.(line, which);
    }
    if (which === "stdout") stdoutBuffer = buffer;
    else stderrBuffer = buffer;
  };

  const flushTail = () => {
    const outTail = stdoutBuffer.trim();
    if (outTail.length > 0) input.onLine?.(outTail, "stdout");
    const errTail = stderrBuffer.trim();
    if (errTail.length > 0) input.onLine?.(errTail, "stderr");
    stdoutBuffer = "";
    stderrBuffer = "";
  };

  const child = spawnProcess(input.command, [...input.args], {
    cwd: input.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: input.env,
  });

  const abortChild = () => {
    aborted = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 3000);
  };

  if (input.signal?.aborted) {
    abortChild();
  } else {
    input.signal?.addEventListener("abort", abortChild, { once: true });
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    stdoutBuffer += text;
    flushLines("stdout");
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    stderrBuffer += text;
    flushLines("stderr");
  });

  child.on("error", (error) => {
    if (killTimer) clearTimeout(killTimer);
    input.signal?.removeEventListener("abort", abortChild);
    const errorText = String(error);
    resolve({
      code: 1,
      stdout,
      stderr: `${stderr}${stderr.length > 0 ? "\n" : ""}${errorText}`,
      combined: [stdout, stderr, errorText].filter((part) => part.trim().length > 0).join("\n"),
      aborted,
    });
  });

  child.on("close", (exitCode) => {
    if (killTimer) clearTimeout(killTimer);
    input.signal?.removeEventListener("abort", abortChild);
    flushTail();
    const code = exitCode ?? 1;
    resolve({
      code,
      stdout,
      stderr,
      combined: [stdout, stderr].filter((part) => part.trim().length > 0).join("\n"),
      aborted,
    });
  });

  return deferred.promise;
};

export const inferMillDriverFromModel = (modelId: string): string => {
  const normalized = modelId.trim().toLowerCase();
  const provider = normalized.includes("/")
    ? normalized.slice(0, normalized.indexOf("/"))
    : normalized;

  if (provider.includes("codex") || normalized.includes("codex")) {
    return "codex";
  }

  if (provider.includes("anthropic") || normalized.includes("claude")) {
    return "claude";
  }

  return "pi";
};

export const buildMillTaskPayload = (input: {
  system: string;
  prompt: string;
  role: string;
  modelId: string;
}): Record<string, unknown> => {
  const driver = inferMillDriverFromModel(input.modelId);
  return {
    agent: {
      driver,
      model: input.modelId,
    },
    role: input.role,
    system: input.system,
    prompt: input.prompt,
  };
};

export const buildMillProgramSource = (input: {
  system: string;
  prompt: string;
  role: string;
  modelId: string;
}): string => {
  const taskPayload = JSON.stringify(buildMillTaskPayload(input));
  return `const task = mill.task(${taskPayload}).start();\nawait task.done;\n`;
};

function writeMillProgramEffect(input: {
  system: string;
  prompt: string;
  agent: string;
  modelId: string;
}): Effect.Effect<{ dir: string; filePath: string }, unknown, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const dir = yield* makeTemporaryDirectoryEffect(
      path.join(temporaryDirectory(), "pi-mill-task-"),
    );
    const filePath = path.join(dir, "program.ts");
    const source = buildMillProgramSource({
      system: input.system,
      prompt: input.prompt,
      role: input.agent,
      modelId: input.modelId,
    });

    yield* writeTextFileEffect(filePath, source, 0o600);
    return { dir, filePath };
  });
}

const decodeMillResult = (
  payloads: ReadonlyArray<Record<string, unknown>>,
  fallback: { agent: string; modelId: string; prompt: string },
): ExecutionResult => {
  const taskResults: Array<MillTaskResult> = [];
  let runFailedMessage: string | undefined;

  for (const payload of payloads) {
    const envelope = payload as MillWatchOutputEnvelope;
    if (envelope.kind !== "event") {
      continue;
    }

    const event = envelope.event;
    if (!isRecord(event)) {
      continue;
    }

    const eventType = readStringField(event, "type");
    const eventPayload = event.payload;

    if (eventType === "task:complete" && isRecord(eventPayload) && isRecord(eventPayload.result)) {
      const result = eventPayload.result;
      taskResults.push({
        text: readStringField(result, "text"),
        sessionRef: readStringField(result, "sessionRef"),
        role: readStringField(result, "role"),
        model: readStringField(result, "model"),
        driver: readStringField(result, "driver"),
        exitCode: typeof result.exitCode === "number" ? result.exitCode : undefined,
        stopReason: readStringField(result, "stopReason"),
        errorMessage: readStringField(result, "errorMessage"),
      });
      continue;
    }

    if (eventType === "run:failed" && isRecord(eventPayload)) {
      runFailedMessage = readStringField(eventPayload, "message");
    }
  }

  if (taskResults.length === 0) {
    return raise(
      new MillError({
        code: "RUNTIME",
        message:
          runFailedMessage && runFailedMessage.length > 0
            ? `mill run failed: ${runFailedMessage}`
            : "mill run completed without task results.",
        recoverable: false,
      }),
    );
  }

  const selectedTask =
    taskResults.find((task) => task.role === fallback.agent) ??
    taskResults[0] ??
    ({} as MillTaskResult);

  const derivedExitCode = typeof selectedTask.exitCode === "number" ? selectedTask.exitCode : 0;

  const errorMessage = selectedTask.errorMessage;
  const stopReason = selectedTask.stopReason;

  if (derivedExitCode !== 0 || stopReason === "error" || (errorMessage?.length ?? 0) > 0) {
    const reason =
      errorMessage ??
      (stopReason !== undefined && stopReason.length > 0
        ? `stopReason=${stopReason}`
        : `exitCode=${derivedExitCode}`);

    return raise(
      new MillError({
        code: "RUNTIME",
        message: `Subagent '${selectedTask.role ?? fallback.agent}' failed: ${reason}`,
        recoverable: false,
      }),
    );
  }

  return {
    taskId: "",
    agent: selectedTask.role ?? fallback.agent,
    task: fallback.prompt,
    exitCode: derivedExitCode,
    messages: [],
    stderr: "",
    usage: newUsage(),
    model: selectedTask.model ?? fallback.modelId,
    stopReason,
    errorMessage,
    step: undefined,
    text: selectedTask.text ?? "",
    sessionPath: selectedTask.sessionRef,
  };
};

const extractRunId = (payload: Record<string, unknown>): string | undefined => {
  const direct = payload.runId;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }

  const nestedRun = payload.run;
  if (typeof nestedRun === "object" && nestedRun !== null) {
    const nestedId = (nestedRun as { id?: unknown }).id;
    if (typeof nestedId === "string" && nestedId.length > 0) {
      return nestedId;
    }
  }

  return undefined;
};

const extractRunStatus = (payload: Record<string, unknown>): string | undefined => {
  const direct = payload.status;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }

  const nestedRun = payload.run;
  if (typeof nestedRun === "object" && nestedRun !== null) {
    const nestedStatus = (nestedRun as { status?: unknown }).status;
    if (typeof nestedStatus === "string" && nestedStatus.length > 0) {
      return nestedStatus;
    }
  }

  return undefined;
};

type ExecutionResultPromise = Promise<Awaited<ExecutionResult>>;

export function runSubagentTask(input: SubagentTaskInput): ExecutionResultPromise {
  return runSubagentProcess(input);
}

async function runSubagentProcess(input: SubagentTaskInput): ExecutionResultPromise {
  input.obs.push(input.runId, "info", `task:start:${input.taskId}`, {
    agent: input.agent,
    model: input.modelId,
    backend: "mill",
    tools: input.tools,
  });

  const outputDir = input.sessionDir ?? path.join(temporaryDirectory(), "pi-mill-output");
  await Effect.runPromise(provideFileSystem(ensureDirectoryEffect(outputDir)));

  const stdoutPath = path.join(outputDir, `${input.taskId}.stdout.log`);

  const result: ExecutionResult = {
    taskId: input.taskId,
    agent: input.agent,
    task: input.prompt,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: newUsage(),
    model: input.modelId,
    step: input.step,
    text: "",
    childRunId: undefined,
    sessionPath: undefined,
  };

  input.onProgress?.({ ...result, messages: [] });

  let system = input.system.trim();
  if (
    input.parentSessionPath &&
    (await Effect.runPromise(provideFileSystem(pathExistsEffect(input.parentSessionPath))))
  ) {
    system += `\n\nParent conversation session: ${input.parentSessionPath}\nUse search_thread to explore parent context if you need background on what led to this task.`;
  }

  const tempProgram = await Effect.runPromise(
    provideFileSystem(
      writeMillProgramEffect({
        system,
        prompt: input.prompt,
        agent: input.agent,
        modelId: input.modelId,
      }),
    ),
  );

  let aborted = input.signal?.aborted ?? false;
  const handleAbort = () => {
    aborted = true;
  };
  input.signal?.addEventListener("abort", handleAbort, { once: true });

  let submittedRunId: string | undefined;
  let cancelRequested = false;

  const requestRunCancel = async (): Promise<void> => {
    if (cancelRequested || submittedRunId === undefined) return;
    cancelRequested = true;
    const cancelArgs = [...input.millArgs, "cancel", submittedRunId, "--json"];
    if (input.millRunsDir && input.millRunsDir.trim().length > 0) {
      cancelArgs.push("--runs-dir", input.millRunsDir);
    }

    const cancelled = await runCommandCapture({
      command: input.millCommand,
      args: cancelArgs,
      cwd: input.cwd,
    });
    await Effect.runPromise(
      provideFileSystem(
        appendCommandLogEffect(stdoutPath, input.millCommand, cancelArgs, cancelled),
      ),
    );
  };

  const metadata = JSON.stringify({
    source: "pi-mill",
    parentRunId: input.runId,
    parentTaskId: input.taskId,
    parentTask: input.prompt,
    parentAgent: input.agent,
    piSessionKey: input.piSessionKey,
  });

  const submitArgs = [
    ...input.millArgs,
    "run",
    tempProgram.filePath,
    "--json",
    "--meta-json",
    metadata,
  ];
  if (input.millRunsDir && input.millRunsDir.trim().length > 0) {
    submitArgs.push("--runs-dir", input.millRunsDir);
  }

  const submitted = await runCommandCapture({
    command: input.millCommand,
    args: submitArgs,
    cwd: input.cwd,
    signal: input.signal,
  });
  await Effect.runPromise(
    provideFileSystem(appendCommandLogEffect(stdoutPath, input.millCommand, submitArgs, submitted)),
  );

  if (submitted.aborted || aborted) {
    return raise(
      new MillError({
        code: "CANCELLED",
        message: "Subagent aborted.",
        recoverable: true,
      }),
    );
  }

  if (submitted.code !== 0) {
    return raise(
      new MillError({
        code: "RUNTIME",
        message:
          submitted.combined.trim().length > 0
            ? `mill run failed:\n${submitted.combined.trim()}`
            : "mill run failed.",
        recoverable: false,
      }),
    );
  }

  const submitPayload = parseJsonObjectFromText([submitted.stdout, submitted.stderr].join("\n")) as
    | MillRunSubmitPayload
    | Record<string, unknown>
    | undefined;
  if (!submitPayload) {
    return raise(
      new MillError({
        code: "RUNTIME",
        message: "mill run did not return JSON submission payload.",
        recoverable: false,
      }),
    );
  }

  submittedRunId = extractRunId(submitPayload as Record<string, unknown>);
  if (!submittedRunId) {
    return raise(
      new MillError({
        code: "RUNTIME",
        message: "mill run submission payload is missing runId.",
        recoverable: false,
      }),
    );
  }

  input.obs.push(input.runId, "info", `task:submitted:${input.taskId}`, {
    taskId: input.taskId,
    childRunId: submittedRunId,
  });

  result.childRunId = submittedRunId;
  input.onSubmittedRunId?.(submittedRunId, input.taskId);
  input.onProgress?.({ ...result, messages: [] });

  const waitArgs = [...input.millArgs, "wait", submittedRunId, "--timeout", "31536000", "--json"];
  if (input.millRunsDir && input.millRunsDir.trim().length > 0) {
    waitArgs.push("--runs-dir", input.millRunsDir);
  }

  const waited = await runCommandCapture({
    command: input.millCommand,
    args: waitArgs,
    cwd: input.cwd,
    signal: input.signal,
  });
  await Effect.runPromise(
    provideFileSystem(appendCommandLogEffect(stdoutPath, input.millCommand, waitArgs, waited)),
  );

  if (waited.aborted || aborted) {
    await requestRunCancel();
    return raise(
      new MillError({
        code: "CANCELLED",
        message: "Subagent aborted.",
        recoverable: true,
      }),
    );
  }

  if (waited.code !== 0) {
    return raise(
      new MillError({
        code: "RUNTIME",
        message:
          waited.combined.trim().length > 0
            ? `mill wait failed:\n${waited.combined.trim()}`
            : "mill wait failed.",
        recoverable: false,
      }),
    );
  }

  const waitPayload = parseJsonObjectFromText([waited.stdout, waited.stderr].join("\n"));
  const terminalStatus = waitPayload ? extractRunStatus(waitPayload) : undefined;

  if (terminalStatus === "cancelled") {
    return raise(
      new MillError({
        code: "CANCELLED",
        message: "Subagent run was cancelled.",
        recoverable: true,
      }),
    );
  }

  if (terminalStatus === "failed") {
    return raise(
      new MillError({
        code: "RUNTIME",
        message: "Subagent run failed before watch replay.",
        recoverable: false,
      }),
    );
  }

  const watchArgs = [
    ...input.millArgs,
    "watch",
    "--run",
    submittedRunId,
    "--channel",
    "events",
    "--json",
  ];
  if (input.millRunsDir && input.millRunsDir.trim().length > 0) {
    watchArgs.push("--runs-dir", input.millRunsDir);
  }

  const watched = await runCommandCapture({
    command: input.millCommand,
    args: watchArgs,
    cwd: input.cwd,
    signal: input.signal,
  });
  await Effect.runPromise(
    provideFileSystem(appendCommandLogEffect(stdoutPath, input.millCommand, watchArgs, watched)),
  );

  if (watched.aborted || aborted) {
    await requestRunCancel();
    return raise(
      new MillError({
        code: "CANCELLED",
        message: "Subagent aborted.",
        recoverable: true,
      }),
    );
  }

  if (watched.code !== 0) {
    return raise(
      new MillError({
        code: "RUNTIME",
        message:
          watched.combined.trim().length > 0
            ? `mill watch failed:\n${watched.combined.trim()}`
            : "mill watch failed.",
        recoverable: false,
      }),
    );
  }

  const parsedEvents = parseJsonObjectsFromText([watched.stdout, watched.stderr].join("\n"));
  if (parsedEvents.length === 0) {
    return raise(
      new MillError({
        code: "RUNTIME",
        message: "mill watch output did not contain JSON events.",
        recoverable: false,
      }),
    );
  }

  const decoded = decodeMillResult(parsedEvents, {
    agent: input.agent,
    modelId: input.modelId,
    prompt: input.prompt,
  });

  result.agent = decoded.agent;
  result.task = decoded.task;
  result.exitCode = decoded.exitCode;
  result.model = decoded.model;
  result.stopReason = decoded.stopReason;
  result.errorMessage = decoded.errorMessage;
  result.text = decoded.text;
  result.childRunId = submittedRunId;
  result.sessionPath = decoded.sessionPath;
  result.stderr = "";

  input.onProgress?.({ ...result, messages: [] });
  input.signal?.removeEventListener("abort", handleAbort);
  await Effect.runPromise(
    provideFileSystem(
      removePathEffect(tempProgram.dir).pipe(
        Effect.catch((error) =>
          Effect.logWarning("pi-mill.temp-program:remove-failed", { path: tempProgram.dir, error }),
        ),
      ),
    ),
  );
  return result;
}

// ── Mill runtime (program host API) ─────────────────────────────────────

export interface RuntimeSubagentTaskInput {
  agent: string;
  system?: string;
  prompt: string;
  cwd?: string;
  model: string;
  tools?: string[];
  step?: number;
  signal?: AbortSignal;
}

export type RuntimeTaskStatus = "idle" | "running" | "complete" | "failed" | "cancelled";

export interface RuntimeTaskSnapshot {
  id: string;
  status: RuntimeTaskStatus;
  input: RuntimeSubagentTaskInput;
  result?: ExecutionResult;
  error?: string;
}

export interface RuntimeTaskActor {
  id: string;
  taskId: string;
  done: ExecutionResultPromise;
  start(): RuntimeTaskActor;
  stop(): RuntimeTaskActor;
  cancel(reason?: string): RuntimeTaskActor;
  send(command: {
    type: "message" | "context" | "cancel";
    content?: string;
    reason?: string;
  }): RuntimeTaskActor;
  subscribe(listener: (snapshot: RuntimeTaskSnapshot) => void): { unsubscribe(): void };
  getSnapshot(): RuntimeTaskSnapshot;
  [TASK_BRAND]: true;
}

export interface MillRuntime {
  runId: string;
  task(input: RuntimeSubagentTaskInput): RuntimeTaskActor;
  shutdown(cancelRunning?: boolean): Promise<void>;
  observe: {
    log(type: "info" | "warning" | "error", message: string, data?: Record<string, unknown>): void;
    artifact(relativePath: string, content: string): string | null;
  };
}

function validateModelSelector(model: string, agent: string): string {
  if (!model?.trim()) {
    return raise(
      new MillError({
        code: "INVALID_INPUT",
        message: `Task for '${agent}' requires a non-empty 'model'.`,
        recoverable: true,
      }),
    );
  }
  return model;
}

function resolveBundledMillCliPath(): string | undefined {
  const currentFile = fileURLToPath(import.meta.url);
  const extensionDir = path.dirname(currentFile);
  const bundledCliPath = path.join(extensionDir, ".vendor", "mill.mjs");
  const exists = Effect.runSyncExit(provideFileSystem(pathExistsEffect(bundledCliPath)));
  return Exit.isSuccess(exists) && exists.value ? bundledCliPath : undefined;
}

function resolveMillCommand(options?: { millCommand?: string; millArgs?: string[] }): {
  millCommand: string;
  millArgs: string[];
} {
  const configuredCommand =
    options?.millCommand?.trim() || readOptionalConfigString("PI_FACTORY_MILL_CMD")?.trim();
  const configuredArgs = options?.millArgs ?? [];
  const bundledCliPath = resolveBundledMillCliPath();

  if (configuredCommand && configuredCommand.length > 0 && configuredCommand !== "mill") {
    return {
      millCommand: configuredCommand,
      millArgs: configuredArgs,
    };
  }

  if (bundledCliPath) {
    return {
      millCommand: nodeExecutablePath(),
      millArgs: [bundledCliPath, ...configuredArgs],
    };
  }

  if (configuredCommand && configuredCommand.length > 0) {
    return {
      millCommand: configuredCommand,
      millArgs: configuredArgs,
    };
  }

  return {
    millCommand: "mill",
    millArgs: configuredArgs,
  };
}

export function createMillRuntime(
  ctx: ExtensionContext,
  runId: string,
  obs: ObservabilityStore,
  options?: {
    onTaskUpdate?: (result: ExecutionResult) => void;
    onChildRunSubmitted?: (runId: string, taskId: string) => void;
    defaultSignal?: AbortSignal;
    parentSessionPath?: string;
    piSessionKey?: string;
    sessionDir?: string;
    millCommand?: string;
    millArgs?: string[];
    millRunsDir?: string;
  },
): MillRuntime {
  let taskCounter = 0;
  const runtimeAbort = new AbortController();
  const activeTasks = new Map<
    string,
    { controller: AbortController; promise: ExecutionResultPromise }
  >();

  const { millCommand, millArgs } = resolveMillCommand(options);
  const millRunsDir =
    options?.millRunsDir?.trim() ||
    readOptionalConfigString("PI_FACTORY_MILL_RUNS_DIR")?.trim() ||
    path.join(homeDirectory(), ".mill", "runs");

  const millRuntime: MillRuntime = {
    runId,

    task(input) {
      const { agent, prompt, cwd, model, tools, step, signal } = input;
      const system = input.system;
      if (!system?.trim()) {
        return raise(
          new MillError({
            code: "INVALID_INPUT",
            message: `Task for '${agent}' requires non-empty system.`,
            recoverable: true,
          }),
        );
      }
      if (!prompt?.trim()) {
        return raise(
          new MillError({
            code: "INVALID_INPUT",
            message: `Task for '${agent}' requires non-empty prompt.`,
            recoverable: true,
          }),
        );
      }

      const modelId = validateModelSelector(model, agent);

      taskCounter += 1;
      const taskId = `task-${taskCounter}`;
      const taskAbort = new AbortController();

      const relayAbort = () => taskAbort.abort();
      const boundSignals = [signal, options?.defaultSignal, runtimeAbort.signal].filter(
        (s): s is AbortSignal => Boolean(s),
      );
      for (const bound of boundSignals) {
        if (bound.aborted) taskAbort.abort();
        else bound.addEventListener("abort", relayAbort, { once: true });
      }

      let snapshot: RuntimeTaskSnapshot = { id: taskId, status: "idle", input };
      const listeners = new Set<(next: RuntimeTaskSnapshot) => void>();
      const publish = (next: RuntimeTaskSnapshot): void => {
        snapshot = next;
        for (const listener of listeners) listener(snapshot);
      };

      const runTask = (): ExecutionResultPromise =>
        runSubagentTask({
          runId,
          taskId,
          agent,
          system,
          prompt,
          cwd: cwd ?? currentWorkingDirectory(),
          modelId,
          tools: tools ?? [],
          step,
          signal: taskAbort.signal,
          obs,
          onProgress: (partial) => options?.onTaskUpdate?.(partial),
          onSubmittedRunId: (submittedRunId, submittedTaskId) =>
            options?.onChildRunSubmitted?.(submittedRunId, submittedTaskId),
          parentSessionPath: options?.parentSessionPath,
          piSessionKey: options?.piSessionKey,
          sessionDir: options?.sessionDir,
          millCommand,
          millArgs,
          millRunsDir,
        });

      let taskPromise: ExecutionResultPromise | undefined;
      const actor: RuntimeTaskActor = {
        id: taskId,
        taskId,
        get done() {
          return taskPromise ?? actor.start().done;
        },
        start() {
          if (taskPromise !== undefined) return actor;
          publish({ ...snapshot, status: "running" });
          const cleanup = (): void => {
            for (const bound of boundSignals) bound.removeEventListener("abort", relayAbort);
            activeTasks.delete(taskId);
          };
          taskPromise = Effect.runPromise(
            Effect.promise(() => runTask()).pipe(
              Effect.tap((finalResult) =>
                Effect.sync(() => {
                  options?.onTaskUpdate?.(finalResult);
                  publish({ ...snapshot, status: "complete", result: finalResult });
                }),
              ),
              Effect.tapError((error: unknown) =>
                Effect.sync(() => {
                  const message = String(error);
                  publish({
                    ...snapshot,
                    status: taskAbort.signal.aborted ? "cancelled" : "failed",
                    error: message,
                  });
                }),
              ),
              Effect.ensuring(Effect.sync(cleanup)),
            ),
          );
          (taskPromise as ExecutionResultPromise & { [TASK_BRAND]: true; taskId: string })[
            TASK_BRAND
          ] = true;
          (taskPromise as ExecutionResultPromise & { [TASK_BRAND]: true; taskId: string }).taskId =
            taskId;
          activeTasks.set(taskId, { controller: taskAbort, promise: taskPromise });
          return actor;
        },
        stop() {
          return actor.cancel("Task stopped");
        },
        cancel() {
          taskAbort.abort();
          if (taskPromise === undefined) publish({ ...snapshot, status: "cancelled" });
          return actor;
        },
        send(command) {
          if (command.type === "cancel") actor.cancel(command.reason);
          return actor;
        },
        subscribe(listener) {
          listeners.add(listener);
          listener(snapshot);
          return { unsubscribe: () => void listeners.delete(listener) };
        },
        getSnapshot() {
          return snapshot;
        },
        [TASK_BRAND]: true,
      };

      return actor;
    },

    async shutdown(cancelRunning = true) {
      if (cancelRunning) {
        runtimeAbort.abort();
        for (const { controller } of activeTasks.values()) controller.abort();
      }
      const pending = Array.from(activeTasks.values()).map(({ promise }) => promise);
      if (pending.length > 0) await Promise.allSettled(pending);
      obs.push(runId, "info", "runtime:shutdown", { cancelRunning, pending: pending.length });
    },

    observe: {
      log(type, message, data) {
        obs.push(runId, type, message, data);
      },
      artifact(relativePath, content) {
        return obs.writeArtifact(runId, relativePath, content);
      },
    },
  };

  return millRuntime;
}

// ── Preflight typecheck ────────────────────────────────────────────────

const PROGRAM_ENV_PATH = path.join(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "program-env.d.ts",
);

/**
 * Run a preflight typecheck on program code using tsgo (native TypeScript compiler).
 * Returns null if clean, or an error message string if there are type errors.
 * Returns a warning-shaped diagnostic when setup fails; returns null only for a clean check.
 */
export async function preflightTypecheck(code: string): Promise<string | null> {
  return Effect.runPromise(provideFileSystem(preflightTypecheckEffect(code)));
}

const preflightTypecheckEffect = (
  code: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const tmpDirValue = yield* makeTemporaryDirectoryEffect(
      path.join(temporaryDirectory(), "pi-mill-typecheck-"),
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed(`Unable to create preflight typecheck directory: ${String(error)}`),
      ),
    );
    if (!tmpDirValue.startsWith("/")) return tmpDirValue;

    const programPath = path.join(tmpDirValue, "program.ts");
    const configPath = path.join(tmpDirValue, "tsconfig.json");
    const setupExit = yield* Effect.exit(
      Effect.gen(function* () {
        yield* writeTextFileEffect(programPath, `/// <reference path="env.d.ts" />\n${code}`);
        yield* copyFileEffect(PROGRAM_ENV_PATH, path.join(tmpDirValue, "env.d.ts"));
        yield* writeTextFileEffect(
          configPath,
          JSON.stringify({
            compilerOptions: {
              target: "ES2022",
              module: "ES2022",
              moduleResolution: "bundler",
              moduleDetection: "force",
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              types: [],
            },
            include: ["program.ts", "env.d.ts"],
          }),
        );
      }),
    );
    if (Exit.isFailure(setupExit)) {
      return `Unable to prepare preflight typecheck files in ${tmpDirValue}.`;
    }

    const commandResult = yield* Effect.promise(() =>
      runCommandCapture({
        command: "tsgo",
        args: ["--noEmit", "-p", configPath],
        cwd: tmpDirValue,
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed({ code: -1, stderr: String(error) } as CommandCapture),
      ),
    );
    if (commandResult.code === -1) return `Unable to execute tsgo preflight typecheck.`;
    if (commandResult.code === 0) return null;

    const errors = commandResult.stderr
      .split("\n")
      .filter((l) => l.includes("error TS"))
      .join("\n")
      .trim();

    const details = errors || commandResult.stderr.trim();
    if (!details) return null;
    return `Program source preserved at: ${programPath}\n${details}`;
  });

// ── Program module preparation ─────────────────────────────────────────

export const prepareProgramModuleEffect = (
  code: string,
): Effect.Effect<{ modulePath: string }, MillError | unknown, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (!code.trim()) {
      return yield* Effect.fail(
        new MillError({
          code: "INVALID_INPUT",
          message: "Program code is empty.",
          recoverable: true,
        }),
      );
    }
    const tmpDir = yield* makeTemporaryDirectoryEffect(
      path.join(temporaryDirectory(), "pi-mill-program-"),
    );
    const modulePath = path.join(tmpDir, "program.ts");
    yield* writeTextFileEffect(modulePath, code);
    return { modulePath };
  });

export function prepareProgramModule(code: string): Promise<{ modulePath: string }> {
  return Effect.runPromise(provideFileSystem(prepareProgramModuleEffect(code)));
}
