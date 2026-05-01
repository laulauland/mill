import {
  Argument as Args,
  CliError,
  CliOutput,
  Command as CliCommand,
  Flag as Options,
} from "effect/unstable/cli";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Cause, Config, Context, Effect, Exit, Layer, Option, Scope } from "effect";
import { ChildProcess } from "effect/unstable/process";
import {
  createMillRuntime,
  type AgentRuntime,
  type AgentProcessConfig,
  type LaunchWorkerInput,
  ProcessControlError,
  type ProcessControl,
  type ProcessSignal,
} from "@mill/core";
import {
  createClaudeAcpAgentProvider,
  createCodexAcpAgentProvider,
  createPiAcpAgentProvider,
} from "@mill/provider-acp";
import {
  decodeStringArrayJson,
  decodeStringRecordJson,
  decodeStringRecordJsonEffect,
} from "./json.schema";

interface CliIo {
  readonly stdout: (line: string) => void | Promise<void>;
  readonly stderr: (line: string) => void | Promise<void>;
}

interface CliPlatform {
  readonly cwd: Effect.Effect<string>;
  readonly executablePath: Effect.Effect<string>;
  readonly pid: Effect.Effect<number | undefined>;
}

const CliPlatform = Context.Service<CliPlatform>("mill/CliPlatform");

interface RunCliOptions {
  readonly cwd?: string;
  readonly homeDirectory?: string;
  readonly runsDirectory?: string;
  readonly launchWorker?: (input: LaunchWorkerInput) => Promise<void>;
  readonly io?: CliIo;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly argv?: ReadonlyArray<string>;
  readonly executablePath?: string;
  readonly entrypointPath?: string;
  readonly pid?: number;
  readonly processControl?: ProcessControl;
}

interface CliExit {
  readonly _tag: "CliExit";
  readonly code: number;
}

const CLI_ENVIRONMENT_VARIABLES = [
  "CLAUDECODE",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_THREAD_ID",
  "HOME",
  "MILL_ACP_ARGS_JSON",
  "MILL_ACP_COMMAND",
  "MILL_ACP_ENV_JSON",
  "MILL_CLAUDE_ACP_ARGS_JSON",
  "MILL_CLAUDE_ACP_COMMAND",
  "MILL_CLAUDE_ACP_ENV_JSON",
  "MILL_CODEX_ACP_ARGS_JSON",
  "MILL_CODEX_ACP_COMMAND",
  "MILL_CODEX_ACP_ENV_JSON",
  "MILL_PI_ACP_ARGS_JSON",
  "MILL_PI_ACP_COMMAND",
  "MILL_PI_ACP_ENV_JSON",
  "MILL_RUN_DEPTH",
  "MILL_VERSION",
  "PATH",
  "PWD",
  "npm_package_version",
] as const;

declare const __MILL_VERSION__: string | undefined;

const readVersionFromPackageJson = (): string | undefined => undefined;

const resolveCliVersion = (env: Readonly<Record<string, string | undefined>>): string => {
  if (typeof __MILL_VERSION__ === "string" && __MILL_VERSION__.length > 0) {
    return __MILL_VERSION__;
  }

  const envVersion = env.MILL_VERSION ?? env.npm_package_version;

  if (typeof envVersion === "string" && envVersion.length > 0) {
    return envVersion;
  }

  const packageVersion = readVersionFromPackageJson();

  if (packageVersion !== undefined) {
    return packageVersion;
  }

  return "0.0.0";
};

const writeLine = (
  sink: ReturnType<Stdio.Stdio["stdout"]>,
  line: string,
): Effect.Effect<void, unknown> =>
  Stream.fromIterable([`${line}\n`]).pipe(Stream.run(sink), Effect.asVoid);

const createStdioIo = (stdio: Stdio.Stdio): CliIo => ({
  stdout: (line) => Effect.runPromise(writeLine(stdio.stdout(), line)),
  stderr: (line) => Effect.runPromise(writeLine(stdio.stderr(), line)),
});

const normalizeOptionalText = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const parseStringArrayJson = (raw: string | undefined): ReadonlyArray<string> | undefined => {
  if (raw === undefined) {
    return undefined;
  }

  const decoded = decodeStringArrayJson(raw);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

const parseStringRecordJson = (
  raw: string | undefined,
): Readonly<Record<string, string>> | undefined => {
  if (raw === undefined) {
    return undefined;
  }

  const decoded = decodeStringRecordJson(raw);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

const normalizeAcpCommand = (command: string, executablePath: string | undefined): string =>
  command === "bun" && executablePath !== undefined ? executablePath : command;

const readAcpProcessOverride = (
  env: Readonly<Record<string, string | undefined>>,
  prefix: "MILL_PI_ACP" | "MILL_CLAUDE_ACP" | "MILL_CODEX_ACP",
  executablePath: string | undefined,
): AgentProcessConfig | undefined => {
  const command = normalizeOptionalText(env[`${prefix}_COMMAND`] ?? env.MILL_ACP_COMMAND);

  if (command === undefined) {
    return undefined;
  }

  const args = parseStringArrayJson(env[`${prefix}_ARGS_JSON`] ?? env.MILL_ACP_ARGS_JSON) ?? [];
  const configuredEnv = parseStringRecordJson(env[`${prefix}_ENV_JSON`] ?? env.MILL_ACP_ENV_JSON);
  const pathEnv = normalizeOptionalText(env.PATH);
  const processEnv = pathEnv === undefined ? configuredEnv : { ...configuredEnv, PATH: pathEnv };

  return {
    command: normalizeAcpCommand(command, executablePath),
    args,
    env: processEnv,
  } satisfies AgentProcessConfig;
};

const createDefaultAgentRuntimes = (
  env: Readonly<Record<string, string | undefined>>,
  executablePath: string | undefined,
): Readonly<Record<string, AgentRuntime>> => ({
  pi: createPiAcpAgentProvider({
    process: readAcpProcessOverride(env, "MILL_PI_ACP", executablePath),
  }).runtime,
  claude: createClaudeAcpAgentProvider({
    process: readAcpProcessOverride(env, "MILL_CLAUDE_ACP", executablePath),
  }).runtime,
  codex: createCodexAcpAgentProvider({
    process: readAcpProcessOverride(env, "MILL_CODEX_ACP", executablePath),
  }).runtime,
});

const runWithBunServices = <A, E>(effect: Effect.Effect<A, E, unknown>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(effect as Effect.Effect<A, E, BunServices.BunServices>, BunServices.layer),
  );

const readOptionalConfigString = (
  name: (typeof CLI_ENVIRONMENT_VARIABLES)[number],
): Effect.Effect<string | undefined, Config.ConfigError> =>
  Effect.gen(function* () {
    const value = yield* Config.string(name).pipe(Config.option);
    return Option.isSome(value) ? value.value : undefined;
  });

const readCliEnvironment = (): Effect.Effect<
  Readonly<Record<string, string | undefined>>,
  Config.ConfigError
> =>
  Effect.map(
    Effect.forEach(CLI_ENVIRONMENT_VARIABLES, (name) =>
      Effect.map(readOptionalConfigString(name), (value) => [name, value] as const),
    ),
    (entries) => Object.fromEntries(entries),
  );

const readCliBootstrap = (): Effect.Effect<
  {
    readonly argv: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly executablePath: string;
    readonly pid: number | undefined;
  },
  Config.ConfigError,
  Stdio.Stdio | CliPlatform
> =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const platform = yield* CliPlatform;
    const argv = yield* stdio.args;
    const env = yield* readCliEnvironment();
    const cwd = yield* platform.cwd;
    const executablePath = yield* platform.executablePath;
    const pid = yield* platform.pid;
    return { argv, cwd, env, executablePath, pid };
  });

// Effect v4 does not expose a portable signal primitive in the platform services used here.
// This is an explicit platform fallback: invoke the system `kill` binary with an
// argument vector only (no shell string/eval) to perform POSIX signal operations.
const runSignalCommand = (
  args: ReadonlyArray<string>,
  error: ProcessControlError,
): Effect.Effect<boolean, ProcessControlError, BunServices.BunServices> =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make("kill", args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const exitCode = yield* handle.exitCode;
      if (Number(exitCode) !== 0) {
        return yield* Effect.fail(error);
      }
      return true;
    }),
  ).pipe(Effect.mapError(() => error));

const createEffectProcessControl = (): ProcessControl => ({
  isAlive: (pid) =>
    runSignalCommand(
      ["-0", String(pid)],
      new ProcessControlError({ operation: "isAlive", pid, cause: "kill -0 returned non-zero" }),
    ),
  sendSignal: (pid, signal: ProcessSignal) =>
    runSignalCommand(
      [`-${signal}`, String(pid)],
      new ProcessControlError({
        operation: "sendSignal",
        pid,
        signal,
        cause: `kill -${signal} returned non-zero`,
      }),
    ),
});

const pathIsAccessible = (
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<boolean> =>
  fileSystem.access(path).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );

const millBinPath = decodeURIComponent(new URL("./mill.ts", import.meta.url).pathname);

const SCRIPT_ENTRYPOINT_EXTENSION = /\.(?:[mc]?[jt]sx?)$/i;

const normalizePath = (path: string): string => {
  if (path.length <= 1) {
    return path;
  }

  return path.endsWith("/") ? path.slice(0, -1) : path;
};

const joinPath = (base: string, child: string): string =>
  normalizePath(base) === "/" ? `/${child}` : `${normalizePath(base)}/${child}`;

const workerPidPath = (runsDirectory: string, runId: string): string =>
  joinPath(joinPath(runsDirectory, runId), "worker.pid");

const RUN_DEPTH_ENV = "MILL_RUN_DEPTH";

const resolveScriptEntrypointFromArgv = (argv: ReadonlyArray<string>): string | undefined => {
  const candidate = argv[1];

  if (typeof candidate !== "string") {
    return undefined;
  }

  const trimmed = candidate.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    SCRIPT_ENTRYPOINT_EXTENSION.test(trimmed)
  ) {
    return trimmed;
  }

  return undefined;
};

const isBunExecutablePath = (executablePath: string): boolean => {
  const normalized = executablePath.replaceAll("\\", "/").toLowerCase();
  return normalized === "bun" || normalized.endsWith("/bun") || normalized.endsWith("/bun.exe");
};

const buildWorkerCommandArguments = (
  input: LaunchWorkerInput,
  options: {
    readonly isBunRuntime: boolean;
    readonly hasSourceEntrypoint: boolean;
    readonly scriptEntrypoint: string | undefined;
    readonly currentEntrypoint: string | undefined;
  },
): ReadonlyArray<string> => {
  const workerArguments = [
    "_worker",
    "--run-id",
    input.runId,
    "--program",
    input.programPath,
    "--runs-dir",
    input.runsDirectory,
  ];

  if (options.isBunRuntime && options.hasSourceEntrypoint) {
    return ["run", millBinPath, ...workerArguments];
  }

  if (options.scriptEntrypoint !== undefined) {
    return [options.scriptEntrypoint, ...workerArguments];
  }

  return options.currentEntrypoint !== undefined
    ? [options.currentEntrypoint, ...workerArguments]
    : workerArguments;
};

const launchDetachedWorker = async (
  input: LaunchWorkerInput,
  bootstrap: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly argv: ReadonlyArray<string>;
    readonly executablePath: string;
    readonly entrypointPath?: string;
    readonly extendEnv: boolean;
  },
): Promise<void> => {
  await runWithBunServices(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const scriptEntrypointCandidate = resolveScriptEntrypointFromArgv(bootstrap.argv);
      const scriptEntrypoint =
        scriptEntrypointCandidate !== undefined &&
        (yield* pathIsAccessible(fileSystem, scriptEntrypointCandidate))
          ? scriptEntrypointCandidate
          : undefined;
      const hasSourceEntrypoint = yield* pathIsAccessible(fileSystem, millBinPath);
      const workerEnv = Object.fromEntries(
        Object.entries({
          ...bootstrap.env,
          [RUN_DEPTH_ENV]: String(input.runDepth),
        }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );

      const workerCommand = ChildProcess.make(
        bootstrap.executablePath,
        buildWorkerCommandArguments(input, {
          isBunRuntime: isBunExecutablePath(bootstrap.executablePath),
          hasSourceEntrypoint,
          scriptEntrypoint,
          currentEntrypoint: bootstrap.entrypointPath,
        }),
        {
          cwd: input.cwd,
          env: workerEnv,
          extendEnv: bootstrap.extendEnv,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );

      const detachedScope = yield* Scope.make();
      const processHandle = yield* Scope.provide(workerCommand.asEffect(), detachedScope);
      yield* processHandle.unref;
      const pidPath = workerPidPath(input.runsDirectory, input.runId);
      const runDirectory = pidPath.slice(0, pidPath.lastIndexOf("/"));

      yield* fileSystem.makeDirectory(runDirectory, { recursive: true });
      yield* fileSystem.writeFileString(pidPath, `${Number(processHandle.pid)}\n`);
    }),
  );
};

const optionalTextOption = (name: string) => Options.string(name).pipe(Options.optional);

const fromOption = <A>(value: Option.Option<A>): A | undefined =>
  Option.isSome(value) ? value.value : undefined;

const parseMetadataJson = (
  raw: string,
): Effect.Effect<Readonly<Record<string, string>> | undefined, unknown> =>
  Effect.map(decodeStringRecordJsonEffect(raw), (parsed) =>
    Object.keys(parsed).length === 0 ? undefined : parsed,
  );

const toCliEffect = (program: Promise<number>) =>
  Effect.flatMap(
    Effect.tryPromise({
      try: () => program,
      catch: (error) => error,
    }),
    (code) =>
      code === 0
        ? Effect.void
        : Effect.fail<CliExit>({
            _tag: "CliExit",
            code,
          }),
  );

const formatUnknownError = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") {
      return message;
    }
  }

  return String(error);
};

const createCliRuntime = (
  options: RunCliOptions,
  input: {
    readonly runsDirectory?: string;
    readonly launchWorker?: (input: LaunchWorkerInput) => Promise<void>;
  } = {},
) =>
  createMillRuntime({
    cwd: options.cwd,
    homeDirectory: options.homeDirectory,
    env: options.env,
    executablePath: options.executablePath,
    runsDirectory: input.runsDirectory ?? options.runsDirectory,
    agentRuntimes: createDefaultAgentRuntimes(options.env ?? {}, options.executablePath),
    launchWorker: input.launchWorker,
    processControl: options.processControl,
  });

interface RunCommandInput {
  readonly program: string;
  readonly json: boolean;
  readonly sync: boolean;
  readonly runsDir: Option.Option<string>;
  readonly metaJson: Option.Option<string>;
}

const runCommand = async (
  command: RunCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const metadataText = fromOption(command.metaJson);
  let metadata: Readonly<Record<string, string>> | undefined;

  if (metadataText !== undefined) {
    const decodedMetadata = Effect.runSyncExit(parseMetadataJson(metadataText));

    if (Exit.isFailure(decodedMetadata)) {
      await io.stderr(`Invalid --meta-json payload: ${Cause.pretty(decodedMetadata.cause)}`);
      return 1;
    }

    metadata = decodedMetadata.value;
  }

  const runtime = createCliRuntime(options, {
    runsDirectory: fromOption(command.runsDir),
    launchWorker:
      options.launchWorker ??
      ((input) =>
        launchDetachedWorker(input, {
          env: options.env ?? {},
          argv: options.argv ?? [],
          executablePath: options.executablePath ?? options.argv?.[0] ?? "mill",
          entrypointPath: options.entrypointPath,
          extendEnv: options.executablePath === undefined,
        })),
  });
  const run = runtime
    .run({
      programPath: command.program,
      sync: command.sync,
      metadata,
    })
    .start();
  const output = await run.done;

  if (command.sync) {
    const syncOutput = output;

    if (!("run" in syncOutput)) {
      await io.stderr("Synchronous run completed without a result envelope.");
      return 1;
    }

    if (command.json) {
      await io.stdout(JSON.stringify(syncOutput));
      return 0;
    }

    await io.stdout(`run ${syncOutput.run.id} -> ${syncOutput.run.status}`);
    return 0;
  }

  const submittedRun = output;

  if ("run" in submittedRun) {
    await io.stderr("Asynchronous run unexpectedly returned a sync result envelope.");
    return 1;
  }

  if (command.json) {
    await io.stdout(
      JSON.stringify({
        runId: submittedRun.id,
        status: submittedRun.status,
        paths: submittedRun.paths,
      }),
    );
    return 0;
  }

  await io.stdout(`run ${submittedRun.id} submitted status=${submittedRun.status}`);
  return 0;
};

interface WorkerCommandInput {
  readonly runId: string;
  readonly program: string;
  readonly runsDir: Option.Option<string>;
  readonly json: boolean;
}

const workerCommand = async (
  command: WorkerCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const runtime = createCliRuntime(options, {
    runsDirectory: fromOption(command.runsDir),
  });

  const output = await runtime.worker({
    runId: command.runId,
    programPath: command.program,
    workerPid: options.pid,
  });

  if (command.json) {
    await io.stdout(JSON.stringify(output));
  }

  return 0;
};

interface StatusCommandInput {
  readonly runId: string;
  readonly json: boolean;
  readonly runsDir: Option.Option<string>;
}

const statusCommand = async (
  command: StatusCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const runtime = createCliRuntime(options, {
    runsDirectory: fromOption(command.runsDir),
  });

  const output = await runtime.runRef(command.runId).getSnapshot();

  if (command.json) {
    await io.stdout(JSON.stringify(output));
    return 0;
  }

  await io.stdout(`run ${output.id} status=${output.status}`);
  return 0;
};

interface WaitCommandInput {
  readonly runId: string;
  readonly timeout: number;
  readonly json: boolean;
  readonly runsDir: Option.Option<string>;
}

const waitCommand = async (
  command: WaitCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  if (!Number.isFinite(command.timeout) || command.timeout <= 0) {
    await io.stderr("--timeout must be a positive number.");
    return 1;
  }

  const timeoutSeconds = command.timeout;
  const runtime = createCliRuntime(options, {
    runsDirectory: fromOption(command.runsDir),
  });

  const [waitResult] = await Promise.allSettled([
    runtime.runRef(command.runId).wait({ timeoutSeconds }),
  ]);

  if (waitResult.status === "fulfilled") {
    if (command.json) {
      await io.stdout(JSON.stringify(waitResult.value));
      return 0;
    }

    await io.stdout(`run ${waitResult.value.id} status=${waitResult.value.status}`);
    return 0;
  }

  const waitError = waitResult.reason as {
    readonly _tag?: string;
    readonly message?: string;
  };

  if (waitError._tag === "WaitTimeoutError") {
    const message = `Timeout waiting for run ${command.runId} after ${timeoutSeconds}s.`;

    if (command.json) {
      await io.stdout(
        JSON.stringify({
          ok: false,
          error: {
            _tag: "WaitTimeoutError",
            runId: command.runId,
            timeoutSeconds,
            message,
          },
        }),
      );
      return 2;
    }

    await io.stderr(message);
    return 2;
  }

  const fallbackMessage = waitError.message ?? String(waitResult.reason);

  if (command.json) {
    await io.stdout(
      JSON.stringify({
        ok: false,
        error: {
          _tag: "WaitError",
          runId: command.runId,
          timeoutSeconds,
          message: fallbackMessage,
        },
      }),
    );
    return 1;
  }

  await io.stderr(fallbackMessage);
  return 1;
};

const WATCH_CHANNELS = ["events", "io", "all"] as const;
const WATCH_SOURCES = ["agent", "program"] as const;

type WatchChannel = (typeof WATCH_CHANNELS)[number];
type WatchSource = (typeof WATCH_SOURCES)[number];

interface WatchCommandInput {
  readonly run: Option.Option<string>;
  readonly sinceTime: Option.Option<string>;
  readonly channel: Option.Option<WatchChannel>;
  readonly source: Option.Option<WatchSource>;
  readonly task: Option.Option<string>;
  readonly json: boolean;
  readonly runsDir: Option.Option<string>;
}

const watchCommand = async (
  command: WatchCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const runtime = createCliRuntime(options, {
    runsDirectory: fromOption(command.runsDir),
  });
  const watchInput = {
    channel: fromOption(command.channel),
    source: fromOption(command.source),
    taskId: fromOption(command.task),
    sinceTimeIso: fromOption(command.sinceTime),
    onEvent: (line: string) => {
      void io.stdout(line);
    },
  } as const;

  const runId = fromOption(command.run);

  if (runId === undefined) {
    await runtime.watch(watchInput);
  } else {
    await runtime.runRef(runId).watch(watchInput);
  }

  return 0;
};

interface CancelCommandInput {
  readonly runId: string;
  readonly json: boolean;
  readonly runsDir: Option.Option<string>;
}

const cancelCommand = async (
  command: CancelCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const runtime = createCliRuntime(options, {
    runsDirectory: fromOption(command.runsDir),
  });

  const cancelled = await runtime.runRef(command.runId).cancel();

  if (command.json) {
    await io.stdout(JSON.stringify(cancelled));
    return 0;
  }

  await io.stdout(`run ${cancelled.runId} status=${cancelled.status}`);
  return 0;
};

const RUN_STATUSES = ["pending", "running", "complete", "failed", "cancelled"] as const;
type RunStatus = (typeof RUN_STATUSES)[number];

interface LsCommandInput {
  readonly json: boolean;
  readonly status: Option.Option<RunStatus>;
  readonly runsDir: Option.Option<string>;
}

const lsCommand = async (
  command: LsCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const runtime = createCliRuntime(options, {
    runsDirectory: fromOption(command.runsDir),
  });

  const runs = await runtime.list({
    status: fromOption(command.status),
  });

  if (command.json) {
    await io.stdout(JSON.stringify(runs));
    return 0;
  }

  if (runs.length === 0) {
    await io.stdout("No runs found.");
    return 0;
  }

  await io.stdout(runs.map((run) => `${run.id}\t${run.status}\t${run.updatedAt}`).join("\n"));
  return 0;
};

const createCli = (options: RunCliOptions, io: CliIo) => {
  const run = CliCommand.make(
    "run",
    {
      program: Args.string("program.ts"),
      json: Options.boolean("json"),
      sync: Options.boolean("sync"),
      runsDir: optionalTextOption("runs-dir"),
      metaJson: optionalTextOption("meta-json"),
    },
    (command) => toCliEffect(runCommand(command, options, io)),
  ).pipe(CliCommand.withDescription("Run a mill program."));

  const worker = CliCommand.make(
    "_worker",
    {
      runId: Options.string("run-id"),
      program: Options.string("program"),
      runsDir: optionalTextOption("runs-dir"),
      json: Options.boolean("json"),
    },
    (command) => toCliEffect(workerCommand(command, options, io)),
  ).pipe(CliCommand.withDescription("Run the detached worker for an existing run."));

  const status = CliCommand.make(
    "status",
    {
      runId: Args.string("runId"),
      json: Options.boolean("json"),
      runsDir: optionalTextOption("runs-dir"),
    },
    (command) => toCliEffect(statusCommand(command, options, io)),
  ).pipe(CliCommand.withDescription("Read the current run status."));

  const wait = CliCommand.make(
    "wait",
    {
      runId: Args.string("runId"),
      timeout: Options.float("timeout"),
      json: Options.boolean("json"),
      runsDir: optionalTextOption("runs-dir"),
    },
    (command) => toCliEffect(waitCommand(command, options, io)),
  ).pipe(CliCommand.withDescription("Wait for a run to reach a terminal state."));

  const watch = CliCommand.make(
    "watch",
    {
      run: optionalTextOption("run"),
      sinceTime: optionalTextOption("since-time"),
      channel: Options.choice("channel", WATCH_CHANNELS).pipe(Options.optional),
      source: Options.choice("source", WATCH_SOURCES).pipe(Options.optional),
      task: optionalTextOption("task"),
      json: Options.boolean("json"),
      runsDir: optionalTextOption("runs-dir"),
    },
    (command) => toCliEffect(watchCommand(command, options, io)),
  ).pipe(
    CliCommand.withDescription(
      "Watch run streams. --channel events|io|all (default: events). --channel io|all requires --run.",
    ),
  );

  const cancel = CliCommand.make(
    "cancel",
    {
      runId: Args.string("runId"),
      json: Options.boolean("json"),
      runsDir: optionalTextOption("runs-dir"),
    },
    (command) => toCliEffect(cancelCommand(command, options, io)),
  ).pipe(CliCommand.withDescription("Cancel a run."));

  const ls = CliCommand.make(
    "ls",
    {
      json: Options.boolean("json"),
      status: Options.choice("status", RUN_STATUSES).pipe(Options.optional),
      runsDir: optionalTextOption("runs-dir"),
    },
    (command) => toCliEffect(lsCommand(command, options, io)),
  ).pipe(CliCommand.withDescription("List runs."));

  return CliCommand.make("mill").pipe(
    CliCommand.withDescription("Mill orchestration runtime."),
    CliCommand.withSubcommands([run, status, wait, watch, cancel, ls, worker]),
  );
};

const STATIC_AUTHORING_HELP_LINES = [
  '  agent = WHICH provider/model should do the task, e.g. codex("openai-codex/gpt-5.3-codex")',
  "  system = WHO the agent is (personality, methodology, output format)",
  "  prompt = WHAT to do now (specific files, concrete task)",
] as const;

type ResolvedAuthoringHelp = { readonly source: "static" };

interface ResolvedHelpContext {
  readonly authoring: ResolvedAuthoringHelp;
}

const renderAuthoringHelp = (_authoringHelp: ResolvedAuthoringHelp): string =>
  `Authoring:\n${STATIC_AUTHORING_HELP_LINES.join("\n")}`;

const renderProviderHelp = (): string =>
  [
    "Providers:",
    "  codex(model)  ACP provider using the codex-acp command",
    "  claude(model) ACP provider using the claude command",
    "  pi(model)     ACP provider using the pi acp command",
  ].join("\n");

const buildHelpText = (helpContext: ResolvedHelpContext, version: string): string =>
  `mill ${version} - orchestration runtime for AI agents

Usage: mill <command> [options]

Commands:
  run <program.ts>              Run a mill program
  status <runId>                Show run state
  wait <runId> --timeout <s>    Wait for terminal state
  watch [--run <runId>]         Watch events/io streams (use --channel events|io|all)
  cancel <runId>                Cancel a running execution
  ls                            List runs

Global options: --json, --runs-dir <path>

${renderProviderHelp()}

Examples:

  Sequential pipeline:
    import { claude, codex, mill } from "@mill/core/program";
    const scan = mill.task({
      agent: codex("openai-codex/gpt-5.3-codex"),
      role: "scout",
      system: "You are a code risk analyst.",
      prompt: "Review src/auth and summarize top security risks.",
    }).start();
    const scanResult = await scan.done;
    const plan = mill.task({
      agent: claude("anthropic/claude-sonnet-4-6"),
      role: "planner",
      system: "You turn findings into an execution-ready plan.",
      prompt: \`Create remediation steps from:\\n\\n\${scanResult.text}\`,
    }).start();

  Parallel fan-out:
    import { claude, codex, mill } from "@mill/core/program";
    const security = mill.task({ agent: claude("anthropic/claude-sonnet-4-6"), prompt: "Review src/auth/" }).start();
    const perf = mill.task({ agent: codex("openai-codex/gpt-5.3-codex"), prompt: "Profile src/api/" }).start();
    const [securityResult, perfResult] = await Promise.all([security.done, perf.done]);

${renderAuthoringHelp(helpContext.authoring)}

Run mill <command> --help for details.`;

const HELP_FLAGS = new Set(["--help", "-h"]);

const COMMAND_NAMES = new Set(["run", "status", "wait", "watch", "cancel", "ls", "_worker"]);

const isHelpRequest = (argv: ReadonlyArray<string>): boolean => {
  if (argv.length === 0) return true;

  return argv.length === 1 && HELP_FLAGS.has(argv[0] ?? "");
};

const isCommandHelpRequest = (argv: ReadonlyArray<string>): boolean => {
  const commandName = argv[0];

  if (commandName === undefined || !COMMAND_NAMES.has(commandName)) {
    return false;
  }

  return argv.slice(1).some((argument) => HELP_FLAGS.has(argument));
};

const resolveHelpContextForHelpEffect = (): Effect.Effect<ResolvedHelpContext> =>
  Effect.succeed({ authoring: { source: "static" } });

const createCliHelpFormatter = (): CliOutput.Formatter => {
  const defaultFormatter = CliOutput.defaultFormatter({ colors: false });

  return {
    ...defaultFormatter,
    formatHelpDoc: (doc) => {
      const formatted = defaultFormatter.formatHelpDoc(doc);

      if (doc.usage === "mill run [flags] <program.ts>") {
        return `$ run [--json] [--sync] [--runs-dir string] [--meta-json string] <program.ts>\n\n${formatted}`;
      }

      return formatted;
    },
  };
};

export const runCliEffect = (
  argv: ReadonlyArray<string>,
  options?: RunCliOptions,
): Effect.Effect<number, never, unknown> =>
  Effect.gen(function* () {
    const resolvedOptions = options ?? {};
    const stdio = yield* Stdio.Stdio;
    const io = resolvedOptions.io ?? createStdioIo(stdio);
    const cliVersion = resolveCliVersion(resolvedOptions.env ?? {});

    if (isHelpRequest(argv)) {
      const helpContext = yield* resolveHelpContextForHelpEffect();
      yield* Effect.promise(() =>
        Promise.resolve(io.stdout(buildHelpText(helpContext, cliVersion))),
      );
      return 0;
    }

    const commandHelpRequest = isCommandHelpRequest(argv);
    const helpContext = commandHelpRequest ? yield* resolveHelpContextForHelpEffect() : undefined;

    const command = createCli(resolvedOptions, io);
    const run = CliCommand.runWith(command, {
      version: cliVersion,
    });

    const exitCode = yield* run(argv).pipe(
      Effect.as(0),
      Effect.catchIf(
        (error): error is CliExit =>
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          error._tag === "CliExit",
        (error) => Effect.succeed(error.code),
      ),
      Effect.catchIf(
        (error): error is CliError.CliError => CliError.isCliError(error),
        (error) =>
          Effect.promise(async () => {
            if (error._tag !== "ShowHelp") {
              await io.stderr(formatUnknownError(error));
            }

            return error._tag === "ShowHelp" ? (error.errors.length === 0 ? 0 : 1) : 1;
          }),
      ),
      Effect.catch((error) =>
        Effect.promise(async () => {
          await io.stderr(formatUnknownError(error));
          return 1;
        }),
      ),
      Effect.provide(CliOutput.layer(createCliHelpFormatter())),
    );

    if (commandHelpRequest && exitCode === 0 && helpContext !== undefined) {
      yield* Effect.promise(() =>
        Promise.resolve(io.stdout(`Authoring:\n${STATIC_AUTHORING_HELP_LINES.join("\n")}`)),
      );

      yield* Effect.promise(() => Promise.resolve(io.stdout(renderProviderHelp())));
    }

    return exitCode;
  });

export const runCli = (argv: ReadonlyArray<string>, options?: RunCliOptions): Promise<number> =>
  runWithBunServices(
    Effect.provide(
      Effect.gen(function* () {
        const platform = yield* CliPlatform;
        const cwd = options?.cwd ?? (yield* platform.cwd);
        const executablePath = options?.executablePath ?? (yield* platform.executablePath);
        return yield* runCliEffect(argv, {
          ...options,
          argv: options?.argv ?? argv,
          cwd,
          executablePath,
        });
      }),
      bunCliPlatformLayer,
    ),
  );

export const bunCliPlatformLayer: Layer.Layer<CliPlatform, never, Path.Path> = Layer.effect(
  CliPlatform,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const bun = (
      globalThis as {
        readonly Bun?: { readonly cwd: string; readonly argv: ReadonlyArray<string> };
      }
    ).Bun;
    return {
      cwd: Effect.sync(() => (bun === undefined ? path.resolve(".") : bun.cwd)),
      executablePath: Effect.sync(() => bun?.argv[0] ?? "node"),
      pid: Effect.succeed(undefined),
    } satisfies CliPlatform;
  }),
);

export const runCliMainEffect = (options?: {
  readonly entrypointPath?: string;
}): Effect.Effect<number, never, unknown> =>
  Effect.gen(function* () {
    const bootstrap = yield* readCliBootstrap();
    return yield* runCliEffect(bootstrap.argv, {
      cwd: bootstrap.cwd,
      env: bootstrap.env,
      executablePath: bootstrap.executablePath,
      entrypointPath: options?.entrypointPath,
      pid: bootstrap.pid,
      processControl: createEffectProcessControl(),
    });
  }).pipe(Effect.catch(() => Effect.succeed(1)));
