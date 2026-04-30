import type * as Effect from "effect/Effect";

export interface AgentProvider {
  readonly driver: string;
  readonly model: string;
  readonly displayName?: string;
}

export type SteeringPolicy = "queue" | "interrupt" | "reject";

export interface TaskInput {
  readonly agent: AgentProvider;
  readonly prompt: string;
  readonly system?: string;
  readonly role?: string;
  readonly steering?: SteeringPolicy;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface TaskRef {
  readonly runId: string;
  readonly taskId: string;
}

export type TaskCommand =
  | {
      readonly type: "message";
      readonly content: string;
      readonly mode?: SteeringPolicy;
    }
  | {
      readonly type: "context";
      readonly content: string;
      readonly from?: TaskRef | string;
      readonly mode?: SteeringPolicy;
    }
  | {
      readonly type: "cancel";
      readonly reason?: string;
    };

export type TaskStatus =
  | "idle"
  | "starting"
  | "running"
  | "waiting"
  | "queued"
  | "interrupting"
  | "complete"
  | "failed"
  | "cancelled";

export interface QueuedTaskMessage {
  readonly type: "message" | "context";
  readonly content: string;
  readonly from?: TaskRef | string;
  readonly mode: SteeringPolicy;
}

export interface TaskSnapshot {
  readonly id: string;
  readonly runId?: string;
  readonly ref?: TaskRef;
  readonly status: TaskStatus;
  readonly input: TaskInput;
  readonly text: string;
  readonly thought: string;
  readonly queue: ReadonlyArray<QueuedTaskMessage>;
  readonly sessionRef?: string;
  readonly result?: TaskResult;
  readonly error?: string;
}

export interface RunSnapshot {
  readonly id: string;
  readonly status: "idle" | "running" | "complete" | "failed" | "cancelled";
  readonly tasks: Readonly<Record<string, TaskSnapshot>>;
  readonly result?: unknown;
  readonly error?: string;
}

export interface TaskActor {
  readonly id: string;
  readonly ref: TaskRef;
  readonly done: Promise<TaskResult>;
  readonly start: () => TaskActor;
  readonly stop: () => TaskActor;
  readonly cancel: (reason?: string) => TaskActor;
  readonly send: (command: TaskCommand) => TaskActor;
  readonly subscribe: (listener: (snapshot: TaskSnapshot) => void) => {
    readonly unsubscribe: () => void;
  };
  readonly getSnapshot: () => TaskSnapshot;
}

export interface RunActor {
  readonly id: string;
  readonly done: Promise<unknown>;
  readonly start: () => RunActor;
  readonly stop: () => RunActor;
  readonly cancel: (reason?: string) => RunActor;
  readonly task: (input: TaskInput) => TaskActor;
  readonly taskRef: (taskId: string) => TaskActor;
  readonly subscribe: (listener: (snapshot: RunSnapshot) => void) => {
    readonly unsubscribe: () => void;
  };
  readonly getSnapshot: () => RunSnapshot;
}

export interface TaskResult {
  readonly text: string;
  readonly sessionRef: string;
  readonly role: string;
  readonly model: string;
  readonly driver: string;
  readonly exitCode: number;
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

export type AgentRuntimeEvent =
  | {
      readonly type: "milestone";
      readonly message: string;
    }
  | {
      readonly type: "tool_call";
      readonly toolName: string;
    }
  | {
      readonly type: "message_chunk";
      readonly text: string;
    }
  | {
      readonly type: "thought_chunk";
      readonly text: string;
    }
  | {
      readonly type: "plan";
      readonly steps: ReadonlyArray<string>;
    };

export interface AgentTurnOutput {
  readonly events: ReadonlyArray<AgentRuntimeEvent>;
  readonly raw?: ReadonlyArray<string>;
  readonly result: TaskResult;
}

export interface AgentSessionInput {
  readonly runId: string;
  readonly runDirectory: string;
  readonly taskId: string;
  readonly role: string;
  readonly system: string;
  readonly model: string;
}

export interface AgentTurnInput {
  readonly prompt: string;
}

export interface AgentSession {
  readonly sessionRef: string;
  readonly startTurn: (input: AgentTurnInput) => Effect.Effect<AgentTurnOutput, unknown>;
  readonly cancelTurn: (reason?: string) => Effect.Effect<void, unknown>;
  readonly close: () => Effect.Effect<void, unknown>;
}

export interface DriverSessionPointer {
  readonly driver: string;
  readonly sessionRef: string;
  readonly pointer: string;
}

export interface AgentRuntime {
  readonly name: string;
  readonly createSession: (input: AgentSessionInput) => Effect.Effect<AgentSession, unknown>;
  readonly resolveSession?: (input: {
    readonly sessionRef: string;
  }) => Effect.Effect<DriverSessionPointer, unknown>;
}

export type DriverRuntime = AgentRuntime;

export interface ExecutorRunInput {
  readonly runId: string;
  readonly programPath: string;
  readonly execute: Effect.Effect<unknown, unknown>;
}

export interface ExecutorRuntime {
  readonly name: string;
  readonly runProgram: (input: ExecutorRunInput) => Effect.Effect<unknown, unknown>;
}

export interface ExtensionContext {
  readonly runId: string;
  readonly driverName: string;
  readonly executorName: string;
}

export interface ExtensionRegistration {
  readonly name: string;
  readonly setup?: (ctx: ExtensionContext) => Effect.Effect<void, unknown>;
  readonly onEvent?: (
    event: { readonly type: string },
    ctx: ExtensionContext,
  ) => Effect.Effect<void, unknown>;
  readonly api?: Readonly<
    Record<string, (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>>
  >;
}

export interface Mill {
  task(input: TaskInput): Promise<TaskResult>;
  taskActor(input: TaskInput): TaskActor;
  runActor(): RunActor;
}

export interface DriverProcessConfig {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

export interface DriverRegistration {
  readonly description: string;
  readonly modelFormat: string;
  readonly process: DriverProcessConfig;
  readonly models: Effect.Effect<ReadonlyArray<string>, never>;
  readonly runtime?: DriverRuntime;
}

export interface ExecutorRegistration {
  readonly description: string;
  readonly runtime: ExecutorRuntime;
}

export interface MillConfig {
  readonly defaultDriver: string;
  readonly defaultExecutor: string;
  readonly maxRunDepth?: number;
  readonly drivers: Readonly<Record<string, DriverRegistration>>;
  readonly executors: Readonly<Record<string, ExecutorRegistration>>;
  readonly extensions: ReadonlyArray<ExtensionRegistration>;
  readonly authoring: {
    readonly instructions: string;
  };
}

export interface DiscoveryPayload {
  readonly discoveryVersion: number;
  readonly programApi: {
    readonly taskRequired: ReadonlyArray<string>;
    readonly taskOptional: ReadonlyArray<string>;
    readonly resultFields: ReadonlyArray<string>;
  };
  readonly drivers: Readonly<
    Record<
      string,
      {
        readonly description: string;
        readonly modelFormat: string;
        readonly models: ReadonlyArray<string>;
      }
    >
  >;
  readonly executors: Readonly<
    Record<
      string,
      {
        readonly description: string;
      }
    >
  >;
  readonly authoring: {
    readonly instructions: string;
  };
  readonly async: {
    readonly submit: string;
    readonly status: string;
    readonly wait: string;
    readonly watch: string;
  };
}

export type ConfigSource = "cwd" | "upward" | "home" | "defaults";

export interface ConfigFileOverrides {
  readonly defaultDriver?: string;
  readonly defaultExecutor?: string;
  readonly maxRunDepth?: number;
  readonly drivers?: Readonly<Record<string, DriverRegistration>>;
  readonly executors?: Readonly<Record<string, ExecutorRegistration>>;
  readonly extensions?: ReadonlyArray<ExtensionRegistration>;
  readonly authoring?: {
    readonly instructions?: string;
  };
}

export interface ResolvedConfig {
  readonly source: ConfigSource;
  readonly configPath?: string;
  readonly config: MillConfig;
}

export interface ResolveConfigOptions {
  readonly defaults: MillConfig;
  readonly cwd?: string;
  readonly homeDirectory?: string;
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly loadConfigModule?: (path: string) => Promise<unknown>;
}
