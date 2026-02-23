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

export interface Mill {
  spawn(input: SpawnInput): Promise<SpawnOutput>;
}

export interface DriverProcessConfig {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
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
