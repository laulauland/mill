import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Ref, Sink, Stream, type Scope } from "effect";
import type { PlatformError } from "effect";
import { ChildProcess } from "effect/unstable/process";
import {
  RemoteProcessError,
  SandboxError,
  type ExecOptions,
  type ExecResult,
  type RemoteProcess,
  type Sandbox,
  type SandboxFactory,
  type SpawnOptions,
} from "@mill/sandbox-core";

export interface DockerSandboxOptions {
  readonly image?: string;
  readonly containerName?: string;
  readonly dockerBin?: string;
  readonly workdir?: string;
  readonly env?: Readonly<Record<string, string>>;
}

const defaultImage = "mill/agent-base:latest";

const withBunServices = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  Effect.provide(effect, BunServices.layer) as Effect.Effect<A, E, never>;

const withBunServicesScoped = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Scope.Scope> =>
  Effect.provide(effect, BunServices.layer) as Effect.Effect<A, E, Scope.Scope>;

const toSandboxError =
  (message: string) =>
  (cause: unknown): SandboxError =>
    new SandboxError({ message, cause });

const toRemoteProcessError =
  (message: string) =>
  (cause: unknown): RemoteProcessError =>
    new RemoteProcessError({ message, cause });

const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
  Effect.gen(function* () {
    const chunks = yield* Ref.make<Array<Uint8Array>>([]);
    yield* stream.pipe(Stream.runForEach((chunk) => Ref.update(chunks, (all) => [...all, chunk])));
    return concatBytes(yield* Ref.get(chunks));
  });

const decodeText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).trim();

const dockerArgsForEnv = (
  env: Readonly<Record<string, string>> | undefined,
): ReadonlyArray<string> =>
  Object.entries(env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);

export const docker = (options: DockerSandboxOptions = {}): SandboxFactory => {
  const dockerBin = options.dockerBin ?? "docker";
  const image = options.image ?? defaultImage;

  return () =>
    withBunServicesScoped(
      Effect.gen(function* () {
        const runContainer = ChildProcess.make(
          dockerBin,
          [
            "run",
            "-d",
            "--rm",
            ...(options.containerName === undefined ? [] : ["--name", options.containerName]),
            ...(options.workdir === undefined ? [] : ["-w", options.workdir]),
            ...dockerArgsForEnv(options.env),
            image,
            "sleep",
            "infinity",
          ],
          { stdout: "pipe", stderr: "pipe" },
        );

        const containerId = yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const process = yield* Effect.fromYieldable(runContainer);
            const stdout = yield* collect(process.stdout);
            const stderr = yield* collect(process.stderr);
            const exitCode = Number(yield* process.exitCode);
            if (exitCode !== 0) {
              return yield* Effect.fail(
                new SandboxError({
                  message: `docker run failed with exit code ${exitCode}: ${decodeText(stderr)}`,
                }),
              );
            }
            return decodeText(stdout);
          }).pipe(Effect.mapError(toSandboxError("Failed to create Docker sandbox"))),
          (id) =>
            Effect.fromYieldable(
              ChildProcess.make(dockerBin, ["rm", "-f", id], {
                stdout: "ignore",
                stderr: "ignore",
              }),
            ).pipe(
              Effect.flatMap((process) => process.exitCode),
              Effect.ignore,
            ),
        );

        const makeDockerExecArgs = (
          command: string,
          args: ReadonlyArray<string>,
          opts: SpawnOptions | undefined,
          interactive: boolean,
        ): ReadonlyArray<string> => [
          "exec",
          ...(interactive ? ["-i"] : []),
          ...(opts?.cwd === undefined ? [] : ["-w", opts.cwd]),
          ...dockerArgsForEnv(opts?.env),
          containerId,
          command,
          ...args,
        ];

        const exec = (command: string, args: ReadonlyArray<string>, opts?: ExecOptions) =>
          Effect.gen(function* () {
            const process = yield* Effect.fromYieldable(
              ChildProcess.make(
                dockerBin,
                makeDockerExecArgs(command, args, opts, opts?.stdin !== undefined),
                {
                  stdin: opts?.stdin === undefined ? "ignore" : Stream.fromIterable([opts.stdin]),
                  stdout: "pipe",
                  stderr: "pipe",
                },
              ),
            );
            const [stdout, stderr] = yield* Effect.all(
              [collect(process.stdout), collect(process.stderr)],
              {
                concurrency: 2,
              },
            );
            const exitCode = Number(yield* process.exitCode);
            return { stdout, stderr, exitCode } satisfies ExecResult;
          }).pipe(
            Effect.scoped,
            Effect.mapError(toSandboxError(`Docker exec failed for ${command}`)),
            withBunServices,
          );

        const spawnAgent = (command: string, args: ReadonlyArray<string>, opts?: SpawnOptions) =>
          withBunServicesScoped(
            Effect.acquireRelease(
              Effect.gen(function* () {
                const process = yield* Effect.fromYieldable(
                  ChildProcess.make(dockerBin, makeDockerExecArgs(command, args, opts, true), {
                    stdin: "pipe",
                    stdout: "pipe",
                    stderr: "pipe",
                  }),
                );

                return {
                  stdin: Sink.mapError(
                    process.stdin,
                    toRemoteProcessError(`Docker stdin failed for ${command}`) as (
                      error: PlatformError.PlatformError,
                    ) => RemoteProcessError,
                  ),
                  stdout: process.stdout.pipe(
                    Stream.mapError(toRemoteProcessError(`Docker stdout failed for ${command}`)),
                  ),
                  stderr: process.stderr.pipe(
                    Stream.mapError(toRemoteProcessError(`Docker stderr failed for ${command}`)),
                  ),
                  exitCode: process.exitCode.pipe(
                    Effect.map(Number),
                    Effect.mapError(
                      toRemoteProcessError(`Docker process exit failed for ${command}`),
                    ),
                  ),
                  kill: (signal?: string) =>
                    process
                      .kill({ killSignal: signal as never })
                      .pipe(
                        Effect.mapError(toRemoteProcessError(`Docker kill failed for ${command}`)),
                      ),
                } satisfies RemoteProcess;
              }).pipe(Effect.mapError(toSandboxError("Failed to spawn agent in Docker sandbox"))),
              (process) => process.kill().pipe(Effect.ignore),
            ),
          );

        return {
          spawnAgent,
          exec,
          readFile: (path) => exec("cat", [path]).pipe(Effect.map((result) => result.stdout)),
          writeFile: (path, data) => exec("tee", [path], { stdin: data }).pipe(Effect.asVoid),
          raw: { containerId, image },
        } satisfies Sandbox;
      }),
    );
};
