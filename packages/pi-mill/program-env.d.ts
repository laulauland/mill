/**
 * Ambient type declarations for pi-mill programs.
 * Available as globals — do not import.
 */

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface ExecutionResult {
  taskId: string;
  agent: string;
  task: string;
  exitCode: number;
  messages: unknown[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  text: string;
  /** Canonical mill child run id (run_...), if available. */
  childRunId?: string;
  /** Subagent session reference (session id or .jsonl path). */
  sessionPath?: string;
}

type SteeringPolicy = "queue" | "interrupt" | "reject";

interface SubagentTaskInput {
  agent: string;
  /** WHO the subagent is and how it should work (behavior, principles, methodology). */
  system?: string;
  /** WHAT the subagent should do right now (specific files, commands, and goals). */
  prompt: string;
  /** Model identifier in provider/model-id format (e.g. "anthropic/claude-opus-4-6", "cerebras/zai-glm-4.7") */
  model: string;
  cwd?: string;
  tools?: string[];
  step?: number;
  signal?: AbortSignal;
}

interface TaskCommand {
  type: "message" | "context" | "cancel";
  content?: string;
  mode?: SteeringPolicy;
  reason?: string;
}

type TaskStatus = "idle" | "running" | "complete" | "failed" | "cancelled";

interface TaskSnapshot {
  id: string;
  status: TaskStatus;
  input: SubagentTaskInput;
  result?: ExecutionResult;
  error?: string;
}

type TaskDone = Promise<Awaited<ExecutionResult>>;

interface TaskActor {
  id: string;
  taskId: string;
  done: TaskDone;
  start(): TaskActor;
  stop(): TaskActor;
  cancel(reason?: string): TaskActor;
  send(command: TaskCommand): TaskActor;
  subscribe(listener: (snapshot: TaskSnapshot) => void): { unsubscribe(): void };
  getSnapshot(): TaskSnapshot;
}

interface Mill {
  runId: string;
  task(input: SubagentTaskInput): TaskActor;
  shutdown(cancelRunning?: boolean): Promise<void>;
  observe: {
    log(type: "info" | "warning" | "error", message: string, data?: Record<string, unknown>): void;
    artifact(relativePath: string, content: string): string | null;
  };
}

/** Runtime API inside pi-mill programs. */
declare const mill: Mill;
declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
  [key: string]: unknown;
};
declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
};
