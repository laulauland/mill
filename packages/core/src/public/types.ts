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
  readonly result: SpawnOutput;
}

export interface DriverRuntime {
  readonly name: string;
  readonly spawn: (input: DriverSpawnInput) => Effect.Effect<DriverSpawnOutput, unknown>;
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

export interface MillConfig {
  readonly defaultDriver: string;
  readonly defaultModel: string;
  readonly drivers: Readonly<Record<string, DriverRegistration>>;
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
  readonly authoring: {
    readonly instructions: string;
  };
  readonly async: {
    readonly submit: string;
    readonly status: string;
    readonly wait: string;
  };
}

export type ConfigSource = "cwd" | "upward" | "home" | "defaults";

export interface ConfigOverrides {
  readonly defaultDriver?: string;
  readonly defaultModel?: string;
  readonly authoringInstructions?: string;
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
  readonly loadConfigOverrides?: (path: string) => Promise<ConfigOverrides>;
}
