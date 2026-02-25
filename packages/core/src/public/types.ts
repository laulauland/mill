import type * as Effect from "effect/Effect";

export interface SpawnInput {
  readonly agent: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly model?: string;
}

export interface SpawnOutput {
  readonly text: string;
  readonly sessionRef: string;
  readonly agent: string;
  readonly model: string;
  readonly driver: string;
  readonly exitCode: number;
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

export interface DriverSpawnInput {
  readonly runId: string;
  readonly spawnId: string;
  readonly agent: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly model: string;
}

export type DriverSpawnEvent =
  | {
      readonly type: "milestone";
      readonly message: string;
    }
  | {
      readonly type: "tool_call";
      readonly toolName: string;
    };

export interface DriverSpawnOutput {
  readonly events: ReadonlyArray<DriverSpawnEvent>;
  readonly raw?: ReadonlyArray<string>;
  readonly result: SpawnOutput;
}

export interface DriverSessionPointer {
  readonly driver: string;
  readonly sessionRef: string;
  readonly pointer: string;
}

export interface DriverRuntime {
  readonly name: string;
  readonly spawn: (input: DriverSpawnInput) => Effect.Effect<DriverSpawnOutput, unknown>;
  readonly resolveSession?: (input: {
    readonly sessionRef: string;
  }) => Effect.Effect<DriverSessionPointer, unknown>;
}

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
  spawn(input: SpawnInput): Promise<SpawnOutput>;
}

export interface DriverProcessConfig {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

export interface DriverCodec {
  readonly modelCatalog: Effect.Effect<ReadonlyArray<string>, never>;
}

export interface DriverRegistration {
  readonly description: string;
  readonly modelFormat: string;
  readonly process: DriverProcessConfig;
  readonly codec: DriverCodec;
  readonly runtime?: DriverRuntime;
}

export interface ExecutorRegistration {
  readonly description: string;
  readonly runtime: ExecutorRuntime;
}

export interface MillConfig {
  readonly defaultDriver: string;
  readonly defaultExecutor: string;
  readonly defaultModel: string;
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
    readonly spawnRequired: ReadonlyArray<string>;
    readonly spawnOptional: ReadonlyArray<string>;
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
  readonly defaultModel?: string;
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
