import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { FactoryError } from "./errors.js";
import type { ObservabilityStore } from "./observability.js";
import type { ExecutionResult } from "./types.js";

// ── Branded spawn promise ──────────────────────────────────────────────

export const SPAWN_BRAND = Symbol.for("pi-mill:spawn");

export interface SpawnPromise extends Promise<ExecutionResult> {
  taskId: string;
  [SPAWN_BRAND]: true;
}

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
    const spawns = items.filter(
      (item): item is any =>
        item != null && typeof item === "object" && (item as any)[SPAWN_BRAND] === true,
    );
    if (spawns.length > 0) {
      groupCounter++;
      const groupId = `group-${groupCounter}`;
      obs.push(runId, "info", "group:start", {
        groupId,
        count: spawns.length,
        tasks: spawns.map((s: any) => s.taskId),
      });
      const result = originalAll(items);
      result.then(
        () => obs.push(runId, "info", "group:done", { groupId, count: spawns.length }),
        () => obs.push(runId, "info", "group:failed", { groupId, count: spawns.length }),
      );
      return result;
    }
    return originalAll(items);
  } as typeof Promise.all;

  Promise.allSettled = function <T>(
    iterable: Iterable<T>,
  ): Promise<PromiseSettledResult<Awaited<T>>[]> {
    const items = Array.from(iterable);
    const spawns = items.filter(
      (item): item is any =>
        item != null && typeof item === "object" && (item as any)[SPAWN_BRAND] === true,
    );
    if (spawns.length > 0) {
      groupCounter++;
      const groupId = `group-settled-${groupCounter}`;
      obs.push(runId, "info", "group:start", {
        groupId,
        count: spawns.length,
        tasks: spawns.map((s: any) => s.taskId),
        settled: true,
      });
      const result = originalAllSettled(items);
      result.then(() => obs.push(runId, "info", "group:done", { groupId, count: spawns.length }));
      return result;
    }
    return originalAllSettled(items);
  } as typeof Promise.allSettled;

  return () => {
    Promise.all = originalAll;
    Promise.allSettled = originalAllSettled;
  };
}

// ── Single subagent spawn (via mill) ───────────────────────────────────

interface SpawnInput {
  runId: string;
  taskId: string;
  agent: string;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  modelId: string;
  tools: string[];
  step?: number;
  signal?: AbortSignal;
  obs: ObservabilityStore;
  onProgress?: (result: ExecutionResult) => void;
  parentSessionPath?: string;
  sessionDir?: string;
  millCommand: string;
  millArgs: string[];
  millRunsDir?: string;
}

interface MillSpawnResult {
  text?: string;
  sessionRef?: string;
  agent?: string;
  model?: string;
  driver?: string;
  exitCode?: number;
  stopReason?: string;
  errorMessage?: string;
}

interface MillRunSyncPayload {
  run?: {
    status?: string;
  };
  result?: {
    spawns?: ReadonlyArray<MillSpawnResult>;
  };
}

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
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }

  return undefined;
};

function writeMillProgram(input: {
  systemPrompt: string;
  prompt: string;
  agent: string;
  modelId: string;
}): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mill-spawn-"));
  const filePath = path.join(dir, "program.ts");
  const spawnPayload = JSON.stringify({
    agent: input.agent,
    systemPrompt: input.systemPrompt,
    prompt: input.prompt,
    model: input.modelId,
  });

  const source = `await mill.spawn(${spawnPayload});\n`;
  fs.writeFileSync(filePath, source, { encoding: "utf-8", mode: 0o600 });
  return { dir, filePath };
}

const decodeMillResult = (
  payload: MillRunSyncPayload,
  fallback: { agent: string; modelId: string; prompt: string },
): ExecutionResult => {
  const spawns = payload.result?.spawns;
  if (!Array.isArray(spawns) || spawns.length === 0) {
    throw new FactoryError({
      code: "RUNTIME",
      message: "mill run completed without spawn results.",
      recoverable: false,
    });
  }

  const selectedSpawn =
    spawns.find((spawn) => spawn.agent === fallback.agent) ?? spawns[0] ?? ({} as MillSpawnResult);

  const runStatus = payload.run?.status;
  const derivedExitCode =
    typeof selectedSpawn.exitCode === "number"
      ? selectedSpawn.exitCode
      : runStatus === "complete"
        ? 0
        : 1;

  return {
    taskId: "",
    agent: selectedSpawn.agent ?? fallback.agent,
    task: fallback.prompt,
    exitCode: derivedExitCode,
    messages: [],
    stderr: "",
    usage: newUsage(),
    model: selectedSpawn.model ?? fallback.modelId,
    stopReason: selectedSpawn.stopReason,
    errorMessage: selectedSpawn.errorMessage,
    step: undefined,
    text: selectedSpawn.text ?? "",
    sessionPath: selectedSpawn.sessionRef,
  };
};

export function spawnSubagent(input: SpawnInput): Promise<ExecutionResult> {
  return runSubagentProcess(input);
}

async function runSubagentProcess(input: SpawnInput): Promise<ExecutionResult> {
  input.obs.push(input.runId, "info", `spawn:${input.taskId}`, {
    agent: input.agent,
    model: input.modelId,
    backend: "mill",
    tools: input.tools,
  });

  const outputDir = input.sessionDir ?? path.join(os.tmpdir(), "pi-mill-output");
  fs.mkdirSync(outputDir, { recursive: true });

  const stdoutPath = path.join(outputDir, `${input.taskId}.stdout.log`);
  const pidPath = path.join(outputDir, `${input.taskId}.pid`);

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
    sessionPath: undefined,
  };

  input.onProgress?.({ ...result, messages: [] });

  let systemPrompt = input.systemPrompt.trim();
  if (input.parentSessionPath && fs.existsSync(input.parentSessionPath)) {
    systemPrompt += `\n\nParent conversation session: ${input.parentSessionPath}\nUse search_thread to explore parent context if you need background on what led to this task.`;
  }

  const tempProgram = writeMillProgram({
    systemPrompt,
    prompt: input.prompt,
    agent: input.agent,
    modelId: input.modelId,
  });

  const args = [...input.millArgs, "run", tempProgram.filePath, "--sync", "--json"];
  if (input.millRunsDir && input.millRunsDir.trim().length > 0) {
    args.push("--runs-dir", input.millRunsDir);
  }

  let aborted = false;

  try {
    const code = await new Promise<number>((resolve) => {
      const stdoutFd = fs.openSync(stdoutPath, "w");
      const childDepth = parseInt(process.env.PI_FACTORY_DEPTH || "0", 10) + 1;
      const proc = spawn(input.millCommand, args, {
        cwd: input.cwd,
        detached: true,
        stdio: ["ignore", stdoutFd, stdoutFd],
        shell: false,
        env: { ...process.env, PI_FACTORY_DEPTH: String(childDepth) },
      });
      proc.unref();
      fs.closeSync(stdoutFd);

      if (proc.pid != null) {
        fs.writeFileSync(pidPath, String(proc.pid), "utf-8");
      }

      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = () => {
        aborted = true;
        proc.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 3000);
      };

      if (input.signal?.aborted) {
        kill();
      }
      input.signal?.addEventListener("abort", kill, { once: true });

      proc.on("close", (exitCode) => {
        if (killTimer) clearTimeout(killTimer);
        try {
          fs.unlinkSync(pidPath);
        } catch {
          // ignore
        }
        resolve(exitCode ?? 1);
      });

      proc.on("error", () => {
        if (killTimer) clearTimeout(killTimer);
        try {
          fs.unlinkSync(pidPath);
        } catch {
          // ignore
        }
        resolve(1);
      });
    });

    const output = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, "utf-8") : "";
    const parsed = parseJsonObjectFromText(output) as MillRunSyncPayload | undefined;

    if (!parsed) {
      result.stderr = output.trim();
      if (aborted) {
        throw new FactoryError({
          code: "CANCELLED",
          message: "Subagent aborted.",
          recoverable: true,
        });
      }
      throw new FactoryError({
        code: "RUNTIME",
        message:
          result.stderr.length > 0
            ? `mill output was not valid JSON:\n${result.stderr}`
            : "mill output was empty.",
        recoverable: false,
      });
    }

    const decoded = decodeMillResult(parsed, {
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
    result.sessionPath = decoded.sessionPath;
    result.stderr = code === 0 ? "" : output.trim();

    if (aborted) {
      throw new FactoryError({
        code: "CANCELLED",
        message: "Subagent aborted.",
        recoverable: true,
      });
    }

    input.onProgress?.({ ...result, messages: [] });
    return result;
  } finally {
    try {
      fs.rmSync(tempProgram.dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ── Factory (program runtime) ──────────────────────────────────────────

export interface RuntimeSpawnInput {
  agent: string;
  systemPrompt: string;
  prompt: string;
  cwd?: string;
  model: string;
  tools?: string[];
  step?: number;
  signal?: AbortSignal;
}

export interface Factory {
  runId: string;
  spawn(input: RuntimeSpawnInput): SpawnPromise;
  shutdown(cancelRunning?: boolean): Promise<void>;
  observe: {
    log(type: "info" | "warning" | "error", message: string, data?: Record<string, unknown>): void;
    artifact(relativePath: string, content: string): string | null;
  };
}

function validateModelSelector(model: string, agent: string): string {
  if (!model?.trim()) {
    throw new FactoryError({
      code: "INVALID_INPUT",
      message: `Spawn for '${agent}' requires a non-empty 'model'.`,
      recoverable: true,
    });
  }
  return model;
}

export function createFactory(
  ctx: ExtensionContext,
  runId: string,
  obs: ObservabilityStore,
  options?: {
    onTaskUpdate?: (result: ExecutionResult) => void;
    defaultSignal?: AbortSignal;
    parentSessionPath?: string;
    sessionDir?: string;
    millCommand?: string;
    millArgs?: string[];
    millRunsDir?: string;
  },
): Factory {
  let spawnCounter = 0;
  const runtimeAbort = new AbortController();
  const activeTasks = new Map<
    string,
    { controller: AbortController; promise: Promise<ExecutionResult> }
  >();

  const millCommand = options?.millCommand?.trim() || process.env.PI_FACTORY_MILL_CMD || "mill";
  const millArgs = options?.millArgs ?? [];
  const millRunsDir = options?.millRunsDir ?? process.env.PI_FACTORY_MILL_RUNS_DIR;

  const factory: Factory = {
    runId,

    spawn({ agent, systemPrompt, prompt, cwd, model, tools, step, signal }) {
      if (!systemPrompt?.trim()) {
        throw new FactoryError({
          code: "INVALID_INPUT",
          message: `Spawn for '${agent}' requires non-empty systemPrompt.`,
          recoverable: true,
        });
      }
      if (!prompt?.trim()) {
        throw new FactoryError({
          code: "INVALID_INPUT",
          message: `Spawn for '${agent}' requires non-empty prompt.`,
          recoverable: true,
        });
      }

      const modelId = validateModelSelector(model, agent);

      spawnCounter += 1;
      const taskId = `task-${spawnCounter}`;
      const taskAbort = new AbortController();

      const relayAbort = () => taskAbort.abort();
      const boundSignals = [signal, options?.defaultSignal, runtimeAbort.signal].filter(
        (s): s is AbortSignal => Boolean(s),
      );
      for (const bound of boundSignals) {
        if (bound.aborted) taskAbort.abort();
        else bound.addEventListener("abort", relayAbort, { once: true });
      }

      const taskPromise = spawnSubagent({
        runId,
        taskId,
        agent,
        systemPrompt,
        prompt,
        cwd: cwd ?? process.cwd(),
        modelId,
        tools: tools ?? [],
        step,
        signal: taskAbort.signal,
        obs,
        onProgress: (partial) => options?.onTaskUpdate?.(partial),
        parentSessionPath: options?.parentSessionPath,
        sessionDir: options?.sessionDir,
        millCommand,
        millArgs,
        millRunsDir,
      })
        .then((finalResult) => {
          options?.onTaskUpdate?.(finalResult);
          return finalResult;
        })
        .finally(() => {
          for (const bound of boundSignals) bound.removeEventListener("abort", relayAbort);
          activeTasks.delete(taskId);
        });
      activeTasks.set(taskId, { controller: taskAbort, promise: taskPromise });

      const branded = taskPromise as any;
      branded[SPAWN_BRAND] = true;
      branded.taskId = taskId;
      return branded as SpawnPromise;
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

  return factory;
}

// ── Preflight typecheck ────────────────────────────────────────────────

const PROGRAM_ENV_PATH = path.join(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "program-env.d.ts",
);

/**
 * Run a preflight typecheck on program code using tsgo (native TypeScript compiler).
 * Returns null if clean, or an error message string if there are type errors.
 * Falls back silently (returns null) if tsgo is not available.
 */
export async function preflightTypecheck(code: string): Promise<string | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mill-typecheck-"));
  const programPath = path.join(tmpDir, "program.ts");
  try {
    fs.writeFileSync(programPath, `/// <reference path="env.d.ts" />\n${code}`, "utf-8");
    fs.copyFileSync(PROGRAM_ENV_PATH, path.join(tmpDir, "env.d.ts"));
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
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

    const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
      let stderr = "";
      const proc = spawn("tsgo", ["--noEmit", "-p", path.join(tmpDir, "tsconfig.json")], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.stdout.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on("close", (exitCode) => resolve({ code: exitCode ?? 1, stderr }));
      proc.on("error", () => resolve({ code: -1, stderr: "" }));
    });

    if (result.code === -1) return null;
    if (result.code === 0) return null;

    const errors = result.stderr
      .split("\n")
      .filter((l) => l.includes("error TS"))
      .join("\n")
      .trim();

    const details = errors || result.stderr.trim();
    if (!details) return null;
    return `Program source preserved at: ${programPath}\n${details}`;
  } catch {
    return null;
  }
}

// ── Program module preparation ─────────────────────────────────────────

export function prepareProgramModule(code: string): { modulePath: string } {
  if (!code.trim()) {
    throw new FactoryError({
      code: "INVALID_INPUT",
      message: "Program code is empty.",
      recoverable: true,
    });
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mill-program-"));
  const modulePath = path.join(tmpDir, "program.ts");
  fs.writeFileSync(modulePath, code, "utf-8");
  return { modulePath };
}
