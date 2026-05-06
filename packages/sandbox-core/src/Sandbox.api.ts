import type { Effect, Scope } from "effect";
import type { RemoteProcess } from "./RemoteProcess.api";
import type { SandboxError } from "./errors.api";

export type ProcessEnv = Readonly<Record<string, string>>;

export interface SpawnOptions {
  readonly cwd?: string;
  readonly env?: ProcessEnv;
}

export interface ExecOptions extends SpawnOptions {
  readonly stdin?: Uint8Array;
}

export interface ExecResult {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number;
}

export interface Sandbox {
  readonly spawnAgent: (
    command: string,
    args: ReadonlyArray<string>,
    opts?: SpawnOptions,
  ) => Effect.Effect<RemoteProcess, SandboxError, Scope.Scope>;
  readonly exec: (
    command: string,
    args: ReadonlyArray<string>,
    opts?: ExecOptions,
  ) => Effect.Effect<ExecResult, SandboxError>;
  readonly readFile: (path: string) => Effect.Effect<Uint8Array, SandboxError>;
  readonly writeFile: (path: string, data: Uint8Array) => Effect.Effect<void, SandboxError>;
  readonly raw: unknown;
}

export type SandboxFactory = () => Effect.Effect<Sandbox, SandboxError, Scope.Scope>;
