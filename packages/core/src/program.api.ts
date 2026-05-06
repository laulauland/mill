// @mill/core/program — Program authoring API
import { Stream } from "effect";
import type { SandboxFactory } from "@mill/sandbox-core";
import type { TaskEvent } from "./schemas/task-event";
import type { TaskOutput, TaskResult, TaskSnapshot, TurnResult } from "./schemas/task-state";
export type {
  TaskCancelledError,
  TaskFailedError,
  TaskOutput,
  TaskResult,
  TaskTerminalError,
  TurnResult,
} from "./schemas/task-state";
export type ShellOutput = Extract<TaskOutput, { readonly kind: "shell" }>;

export interface Agent {
  readonly provider: string;
  readonly model: string;
}

export interface TaskOptions {
  readonly agent: Agent;
  readonly sandbox?: SandboxFactory;
}

export interface ShellOptions {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  readonly failOnNonZeroExit?: boolean;
}

export type SpawnInput =
  | { readonly kind: "agent"; readonly agent: Agent; readonly sandbox?: SandboxFactory }
  | { readonly kind: "shell"; readonly options: ShellOptions };

export interface TaskHandle {
  readonly id: string;
  readonly done: Promise<TaskOutput>;
  readonly subscribe: () => Stream.Stream<TaskEvent>;
  readonly result: () => Promise<TaskResult>;
  readonly snapshot: () => Promise<TaskSnapshot>;
  send(message: string): Promise<TurnResult>;
  complete(): void;
  cancel(reason?: string): void;
  run(message?: string): Promise<TaskOutput>;
}

export interface ProgramContext {
  readonly taskId: string;
  readonly spawnChild: (input: SpawnInput) => TaskHandle;
}

export class ProgramContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramContextError";
  }
}

const notInProgramContext = (): never => {
  throw new ProgramContextError(
    "task() can only be called inside a Mill program. " +
      "Make sure this code is running under `mill run <program.ts>`.",
  );
};

let currentContext: ProgramContext | undefined;

export const withProgramContext = <A>(context: ProgramContext, run: () => A): A => {
  const previousContext = currentContext;
  currentContext = context;
  const result = run();
  currentContext = previousContext;
  return result;
};

export const enterProgramContext = (context: ProgramContext): (() => void) => {
  const previousContext = currentContext;
  currentContext = context;

  return () => {
    currentContext = previousContext;
  };
};

const inertSnapshot = (id: string): TaskSnapshot => ({
  id,
  status: "created",
  text: "",
  thought: "",
  busy: false,
  history: [],
});

export type TaskHandleOperations = {
  readonly done?: Promise<TaskOutput>;
  readonly subscribe?: () => Stream.Stream<TaskEvent>;
  readonly result?: () => Promise<TaskResult>;
  readonly snapshot?: () => Promise<TaskSnapshot>;
  readonly cancel?: (reason?: string) => void;
  readonly send?: (message: string) => Promise<TurnResult>;
  readonly complete?: () => void;
};

export const makeTaskHandle = (id: string, operations: TaskHandleOperations = {}): TaskHandle => ({
  id,
  done: operations.done ?? Promise.resolve({ kind: "agent", text: "" }),
  subscribe: operations.subscribe ?? (() => Stream.empty),
  result:
    operations.result ??
    (() => Promise.resolve({ status: "completed", output: { kind: "agent", text: "" } })),
  snapshot: operations.snapshot ?? (() => Promise.resolve(inertSnapshot(id))),
  send(message: string) {
    return operations.send?.(message) ?? Promise.resolve({ text: "", sequence: 0 });
  },
  complete() {
    operations.complete?.();
  },
  cancel(reason?: string) {
    operations.cancel?.(reason);
  },
  async run(message?: string) {
    if (message !== undefined) {
      await this.send(message);
    }
    this.complete();
    return await this.done;
  },
});

export const task = (options: TaskOptions): TaskHandle => {
  if (currentContext === undefined) {
    return notInProgramContext();
  }

  return currentContext.spawnChild({
    kind: "agent",
    agent: options.agent,
    sandbox: options.sandbox,
  });
};

export const shell = (options: ShellOptions): TaskHandle => {
  if (currentContext === undefined) {
    return notInProgramContext();
  }

  return currentContext.spawnChild({ kind: "shell", options });
};

export const codex = (model: string): Agent => ({ provider: "codex", model });
export const claude = (model: string): Agent => ({ provider: "claude", model });
export const pi = (model = "default"): Agent => ({ provider: "pi", model });
