import {
  Argument as Args,
  CliError,
  CliOutput,
  Command as CliCommand,
  Flag as Options,
} from "effect/unstable/cli";
import * as FileSystem from "effect/FileSystem";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Schema from "effect/Schema";
import { Effect, Option, Scope } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { readFileSync } from "node:fs";
import {
  createMillRuntime,
  defineConfig,
  processDriver,
  resolveConfig,
  type DriverProcessConfig,
  type LaunchWorkerInput,
} from "@mill/core";
import {
  createClaudeAcpDriverRegistration,
  createCodexAcpDriverRegistration,
  createPiAcpDriverRegistration,
} from "@mill/driver-acp";

interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

interface RunCliOptions {
  readonly cwd?: string;
  readonly homeDirectory?: string;
  readonly runsDirectory?: string;
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly loadConfigModule?: (path: string) => Promise<unknown>;
  readonly launchWorker?: (input: LaunchWorkerInput) => Promise<void>;
  readonly io?: CliIo;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface CliExit {
  readonly _tag: "CliExit";
  readonly code: number;
}

declare const __MILL_VERSION__: string | undefined;

const readVersionFromPackageJson = (): string | undefined => {
  try {
    const packageJsonPath = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      readonly version?: unknown;
    };

    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : undefined;
  } catch {
    return undefined;
  }
};

const resolveCliVersion = (): string => {
  if (typeof __MILL_VERSION__ === "string" && __MILL_VERSION__.length > 0) {
    return __MILL_VERSION__;
  }

  const envVersion = process.env.MILL_VERSION ?? process.env.npm_package_version;

  if (typeof envVersion === "string" && envVersion.length > 0) {
    return envVersion;
  }

  const packageVersion = readVersionFromPackageJson();

  if (packageVersion !== undefined) {
    return packageVersion;
  }

  return "0.0.0";
};

const CLI_VERSION = resolveCliVersion();

const defaultIo: CliIo = {
  stdout: (line) => {
    console.log(line);
  },
  stderr: (line) => {
    console.error(line);
  },
};

const createDirectExecutor = () => ({
  description: "Local direct executor",
  runtime: {
    name: "direct",
    runProgram: (input: { readonly execute: Effect.Effect<unknown, unknown> }) => input.execute,
  },
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

  try {
    const parsed = JSON.parse(raw) as unknown;

    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : undefined;
  } catch {
    return undefined;
  }
};

const parseStringRecordJson = (
  raw: string | undefined,
): Readonly<Record<string, string>> | undefined => {
  if (raw === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }

    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );

    return Object.fromEntries(entries);
  } catch {
    return undefined;
  }
};

const normalizeAcpCommand = (command: string): string =>
  command === "bun" ? process.execPath : command;

const readAcpProcessOverride = (
  env: Readonly<Record<string, string | undefined>>,
  prefix: "MILL_PI_ACP" | "MILL_CLAUDE_ACP" | "MILL_CODEX_ACP",
): DriverProcessConfig | undefined => {
  const command = normalizeOptionalText(env[`${prefix}_COMMAND`] ?? env.MILL_ACP_COMMAND);

  if (command === undefined) {
    return undefined;
  }

  const args = parseStringArrayJson(env[`${prefix}_ARGS_JSON`] ?? env.MILL_ACP_ARGS_JSON) ?? [];
  const configuredEnv = parseStringRecordJson(env[`${prefix}_ENV_JSON`] ?? env.MILL_ACP_ENV_JSON);
  const pathEnv = normalizeOptionalText(env.PATH ?? process.env.PATH);
  const processEnv = pathEnv === undefined ? configuredEnv : { ...configuredEnv, PATH: pathEnv };

  return {
    command: normalizeAcpCommand(command),
    args,
    env: processEnv,
  } satisfies DriverProcessConfig;
};

const createDefaultConfig = (env: Readonly<Record<string, string | undefined>>) =>
  defineConfig({
    defaultDriver: "",
    defaultExecutor: "direct",
    maxRunDepth: 1,
    drivers: {
      pi: processDriver(
        createPiAcpDriverRegistration({
          process: readAcpProcessOverride(env, "MILL_PI_ACP"),
          homeDirectory: normalizeOptionalText(env.HOME),
        }),
      ),
      claude: processDriver(
        createClaudeAcpDriverRegistration({
          process: readAcpProcessOverride(env, "MILL_CLAUDE_ACP"),
        }),
      ),
      codex: processDriver(
        createCodexAcpDriverRegistration({
          process: readAcpProcessOverride(env, "MILL_CODEX_ACP"),
        }),
      ),
    },
    executors: {
      direct: createDirectExecutor(),
    },
    extensions: [],
    authoring: {
      instructions:
        "Use agent for provider/model, system for WHO, and prompt for WHAT. Prefer cheaper models for search and stronger models for synthesis.",
    },
  });

const resolveDefaults = (options: RunCliOptions) => createDefaultConfig(options.env ?? process.env);

const runWithBunServices = <A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, BunServices.layer));

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

const dirname = (path: string): string => {
  const normalized = normalizePath(path);

  if (normalized === "/") {
    return "/";
  }

  const index = normalized.lastIndexOf("/");

  if (index <= 0) {
    return "/";
  }

  return normalized.slice(0, index);
};

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
  return normalized.endsWith("/bun") || normalized.endsWith("/bun.exe");
};

const buildWorkerCommandArguments = (
  input: LaunchWorkerInput,
  options: {
    readonly isBunRuntime: boolean;
    readonly hasSourceEntrypoint: boolean;
    readonly scriptEntrypoint: string | undefined;
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
    "--driver",
    input.driverName,
    "--executor",
    input.executorName,
  ];

  if (options.isBunRuntime && options.hasSourceEntrypoint) {
    return ["run", millBinPath, ...workerArguments];
  }

  return options.scriptEntrypoint !== undefined
    ? [options.scriptEntrypoint, ...workerArguments]
    : workerArguments;
};

const launchDetachedWorker = async (
  input: LaunchWorkerInput,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> => {
  await runWithBunServices(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const scriptEntrypointCandidate = resolveScriptEntrypointFromArgv(process.argv);
      const scriptEntrypoint =
        scriptEntrypointCandidate !== undefined &&
        (yield* fileSystem.exists(scriptEntrypointCandidate))
          ? scriptEntrypointCandidate
          : undefined;
      const hasSourceEntrypoint = yield* fileSystem.exists(millBinPath);
      const workerEnv = Object.fromEntries(
        Object.entries({
          ...env,
          [RUN_DEPTH_ENV]: String(input.runDepth),
        }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );

      const workerCommand = ChildProcess.make(
        process.execPath,
        buildWorkerCommandArguments(input, {
          isBunRuntime: isBunExecutablePath(process.execPath),
          hasSourceEntrypoint,
          scriptEntrypoint,
        }),
        {
          cwd: input.cwd,
          env: workerEnv,
          extendEnv: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );

      const detachedScope = yield* Scope.make();
      const processHandle = yield* Scope.provide(workerCommand.asEffect(), detachedScope);
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

const MetadataJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

const parseMetadataJson = (raw: string): Readonly<Record<string, string>> | undefined => {
  const parsed = Schema.decodeUnknownSync(MetadataJson)(raw);

  if (Object.keys(parsed).length === 0) {
    return undefined;
  }

  return parsed;
};

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
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

type ActiveDriverSource = "flag" | "config" | "harness";

interface ActiveDriverResolution {
  readonly name: string;
  readonly source: ActiveDriverSource;
  readonly resolvedConfig: Awaited<ReturnType<typeof resolveConfig>>;
}

const normalizeNonEmptyText = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const inferHarnessDriver = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  if (env.CLAUDECODE === "1") {
    return "claude";
  }

  if (
    normalizeNonEmptyText(env.CODEX_THREAD_ID) !== undefined ||
    normalizeNonEmptyText(env.CODEX_SANDBOX) !== undefined ||
    normalizeNonEmptyText(env.CODEX_SANDBOX_NETWORK_DISABLED) !== undefined
  ) {
    return "codex";
  }

  return undefined;
};

const sourceLabel = (source: ActiveDriverSource): string => {
  if (source === "flag") {
    return "--driver";
  }

  if (source === "config") {
    return "mill.config.ts defaultDriver";
  }

  return "harness inference";
};

const resolveActiveDriverSelection = (
  requestedDriverName: string | undefined,
  resolvedConfig: Awaited<ReturnType<typeof resolveConfig>>,
  env: Readonly<Record<string, string | undefined>>,
): Omit<ActiveDriverResolution, "resolvedConfig"> => {
  const requested = normalizeNonEmptyText(requestedDriverName);
  const configured = normalizeNonEmptyText(resolvedConfig.config.defaultDriver);
  const inferred = inferHarnessDriver(env);

  const source: ActiveDriverSource | undefined =
    requested !== undefined
      ? "flag"
      : configured !== undefined
        ? "config"
        : inferred !== undefined
          ? "harness"
          : undefined;
  const selected = requested ?? configured ?? inferred;
  const available = Object.keys(resolvedConfig.config.drivers).sort((left, right) =>
    left.localeCompare(right),
  );

  if (selected === undefined || source === undefined) {
    throw new Error(
      "Unable to resolve active driver. Provide --driver <name>, set defaultDriver in mill.config.ts, or run from a supported harness (CLAUDECODE=1 => claude, CODEX_THREAD_ID/CODEX_SANDBOX/CODEX_SANDBOX_NETWORK_DISABLED => codex).",
    );
  }

  if (!available.includes(selected)) {
    const renderedAvailable = available.length > 0 ? available.join(", ") : "(none)";

    throw new Error(
      `Resolved active driver '${selected}' from ${sourceLabel(source)} is unavailable. Available drivers: ${renderedAvailable}.`,
    );
  }

  return {
    name: selected,
    source,
  };
};

const resolveActiveDriver = async (
  options: RunCliOptions,
  requestedDriverName: string | undefined,
): Promise<ActiveDriverResolution> => {
  const resolvedConfig = await resolveConfig({
    defaults: resolveDefaults(options),
    cwd: options.cwd,
    homeDirectory: options.homeDirectory,
    pathExists: options.pathExists,
    loadConfigModule: options.loadConfigModule,
  });

  const selection = resolveActiveDriverSelection(
    requestedDriverName,
    resolvedConfig,
    options.env ?? process.env,
  );

  return {
    ...selection,
    resolvedConfig,
  };
};

const createCliRuntime = (
  options: RunCliOptions,
  activeDriver: ActiveDriverResolution,
  input: {
    readonly runsDirectory?: string;
    readonly executorName?: string;
    readonly launchWorker?: (input: LaunchWorkerInput) => Promise<void>;
  } = {},
) =>
  createMillRuntime({
    defaults: activeDriver.resolvedConfig.config,
    cwd: options.cwd,
    homeDirectory: options.homeDirectory,
    runsDirectory: input.runsDirectory ?? options.runsDirectory,
    driverName: activeDriver.name,
    executorName: input.executorName,
    pathExists: options.pathExists,
    loadConfigModule: options.loadConfigModule,
    launchWorker: input.launchWorker,
  });

interface RunCommandInput {
  readonly program: string;
  readonly json: boolean;
  readonly sync: boolean;
  readonly runsDir: Option.Option<string>;
  readonly driver: Option.Option<string>;
  readonly executor: Option.Option<string>;
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
    try {
      metadata = parseMetadataJson(metadataText);
    } catch (error) {
      io.stderr(`Invalid --meta-json payload: ${formatUnknownError(error)}`);
      return 1;
    }
  }

  const activeDriver = await resolveActiveDriver(options, fromOption(command.driver));

  const runtime = createCliRuntime(options, activeDriver, {
    runsDirectory: fromOption(command.runsDir),
    executorName: fromOption(command.executor),
    launchWorker:
      options.launchWorker ?? ((input) => launchDetachedWorker(input, options.env ?? process.env)),
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
      io.stderr("Synchronous run completed without a result envelope.");
      return 1;
    }

    if (command.json) {
      io.stdout(JSON.stringify(syncOutput));
      return 0;
    }

    io.stdout(`run ${syncOutput.run.id} -> ${syncOutput.run.status}`);
    return 0;
  }

  const submittedRun = output;

  if ("run" in submittedRun) {
    io.stderr("Asynchronous run unexpectedly returned a sync result envelope.");
    return 1;
  }

  if (command.json) {
    io.stdout(
      JSON.stringify({
        runId: submittedRun.id,
        status: submittedRun.status,
        paths: submittedRun.paths,
      }),
    );
    return 0;
  }

  io.stdout(`run ${submittedRun.id} submitted status=${submittedRun.status}`);
  return 0;
};

interface WorkerCommandInput {
  readonly runId: string;
  readonly program: string;
  readonly runsDir: Option.Option<string>;
  readonly driver: Option.Option<string>;
  readonly executor: Option.Option<string>;
  readonly json: boolean;
}

const workerCommand = async (
  command: WorkerCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const activeDriver = await resolveActiveDriver(options, fromOption(command.driver));
  const runtime = createCliRuntime(options, activeDriver, {
    runsDirectory: fromOption(command.runsDir),
    executorName: fromOption(command.executor),
  });

  const output = await runtime.worker({
    runId: command.runId,
    programPath: command.program,
  });

  if (command.json) {
    io.stdout(JSON.stringify(output));
  }

  return 0;
};

const INIT_CONFIG_TEMPLATE = [
  "export default {",
  "  // Optional: override driver/executor defaults.",
  "  // maxRunDepth: 1, // recursion guard for nested `mill run`",
  "  authoring: {",
  '    instructions: "Use agent for provider/model, system for WHO (role/method), prompt for WHAT (explicit task + scope + validation). Prefer codex for synthesis, cerebras for fast retrieval.",',
  "  },",
  "};",
].join("\n");

interface InitCommandInput {
  readonly global: boolean;
}

const initCommand = async (
  command: InitCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const cwd = options.cwd ?? process.cwd();
  const homeDirectory = options.homeDirectory ?? process.env.HOME;

  if (command.global && (homeDirectory === undefined || homeDirectory.length === 0)) {
    io.stderr("Unable to resolve home directory for --global init.");
    return 1;
  }

  const configPath = command.global
    ? joinPath(homeDirectory as string, ".mill/config.ts")
    : `${cwd}/mill.config.ts`;

  await runWithBunServices(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(dirname(configPath), { recursive: true });
      yield* fileSystem.writeFileString(configPath, `${INIT_CONFIG_TEMPLATE}\n`);
    }),
  );

  io.stdout(`Created ${configPath}`);
  return 0;
};

interface StatusCommandInput {
  readonly runId: string;
  readonly json: boolean;
  readonly runsDir: Option.Option<string>;
  readonly driver: Option.Option<string>;
}

const statusCommand = async (
  command: StatusCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const activeDriver = await resolveActiveDriver(options, fromOption(command.driver));
  const runtime = createCliRuntime(options, activeDriver, {
    runsDirectory: fromOption(command.runsDir),
  });

  const output = await runtime.runRef(command.runId).getSnapshot();

  if (command.json) {
    io.stdout(JSON.stringify(output));
    return 0;
  }

  io.stdout(`run ${output.id} status=${output.status}`);
  return 0;
};

interface WaitCommandInput {
  readonly runId: string;
  readonly timeout: number;
  readonly json: boolean;
  readonly runsDir: Option.Option<string>;
  readonly driver: Option.Option<string>;
}

const waitCommand = async (
  command: WaitCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  if (!Number.isFinite(command.timeout) || command.timeout <= 0) {
    io.stderr("--timeout must be a positive number.");
    return 1;
  }

  const timeoutSeconds = command.timeout;
  const activeDriver = await resolveActiveDriver(options, fromOption(command.driver));
  const runtime = createCliRuntime(options, activeDriver, {
    runsDirectory: fromOption(command.runsDir),
  });

  const [waitResult] = await Promise.allSettled([
    runtime.runRef(command.runId).wait({ timeoutSeconds }),
  ]);

  if (waitResult.status === "fulfilled") {
    if (command.json) {
      io.stdout(JSON.stringify(waitResult.value));
      return 0;
    }

    io.stdout(`run ${waitResult.value.id} status=${waitResult.value.status}`);
    return 0;
  }

  const waitError = waitResult.reason as {
    readonly _tag?: string;
    readonly message?: string;
  };

  if (waitError._tag === "WaitTimeoutError") {
    const message = `Timeout waiting for run ${command.runId} after ${timeoutSeconds}s.`;

    if (command.json) {
      io.stdout(
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

    io.stderr(message);
    return 2;
  }

  const fallbackMessage = waitError.message ?? String(waitResult.reason);

  if (command.json) {
    io.stdout(
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

  io.stderr(fallbackMessage);
  return 1;
};

const WATCH_CHANNELS = ["events", "io", "all"] as const;
const WATCH_SOURCES = ["driver", "program"] as const;

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
  readonly driver: Option.Option<string>;
}

const watchCommand = async (
  command: WatchCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const activeDriver = await resolveActiveDriver(options, fromOption(command.driver));
  const runtime = createCliRuntime(options, activeDriver, {
    runsDirectory: fromOption(command.runsDir),
  });
  const watchInput = {
    channel: fromOption(command.channel),
    source: fromOption(command.source),
    taskId: fromOption(command.task),
    sinceTimeIso: fromOption(command.sinceTime),
    onEvent: (line: string) => {
      io.stdout(line);
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
  readonly driver: Option.Option<string>;
}

const cancelCommand = async (
  command: CancelCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const activeDriver = await resolveActiveDriver(options, fromOption(command.driver));
  const runtime = createCliRuntime(options, activeDriver, {
    runsDirectory: fromOption(command.runsDir),
  });

  const cancelled = await runtime.runRef(command.runId).cancel();

  if (command.json) {
    io.stdout(JSON.stringify(cancelled));
    return 0;
  }

  io.stdout(`run ${cancelled.runId} status=${cancelled.status}`);
  return 0;
};

const RUN_STATUSES = ["pending", "running", "complete", "failed", "cancelled"] as const;
type RunStatus = (typeof RUN_STATUSES)[number];

interface LsCommandInput {
  readonly json: boolean;
  readonly status: Option.Option<RunStatus>;
  readonly runsDir: Option.Option<string>;
  readonly driver: Option.Option<string>;
}

const lsCommand = async (
  command: LsCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const activeDriver = await resolveActiveDriver(options, fromOption(command.driver));
  const runtime = createCliRuntime(options, activeDriver, {
    runsDirectory: fromOption(command.runsDir),
  });

  const runs = await runtime.list({
    status: fromOption(command.status),
  });

  if (command.json) {
    io.stdout(JSON.stringify(runs));
    return 0;
  }

  if (runs.length === 0) {
    io.stdout("No runs found.");
    return 0;
  }

  io.stdout(runs.map((run) => `${run.id}\t${run.status}\t${run.updatedAt}`).join("\n"));
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
      driver: optionalTextOption("driver"),
      executor: optionalTextOption("executor"),
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
      driver: optionalTextOption("driver"),
      executor: optionalTextOption("executor"),
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
      driver: optionalTextOption("driver"),
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
      driver: optionalTextOption("driver"),
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
      driver: optionalTextOption("driver"),
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
      driver: optionalTextOption("driver"),
    },
    (command) => toCliEffect(cancelCommand(command, options, io)),
  ).pipe(CliCommand.withDescription("Cancel a run."));

  const ls = CliCommand.make(
    "ls",
    {
      json: Options.boolean("json"),
      status: Options.choice("status", RUN_STATUSES).pipe(Options.optional),
      runsDir: optionalTextOption("runs-dir"),
      driver: optionalTextOption("driver"),
    },
    (command) => toCliEffect(lsCommand(command, options, io)),
  ).pipe(CliCommand.withDescription("List runs."));

  const init = CliCommand.make(
    "init",
    {
      global: Options.boolean("global"),
    },
    (command) => toCliEffect(initCommand(command, options, io)),
  ).pipe(
    CliCommand.withDescription(
      "Create a starter config (local mill.config.ts or ~/.mill/config.ts with --global).",
    ),
  );

  return CliCommand.make("mill").pipe(
    CliCommand.withDescription("Mill orchestration runtime."),
    CliCommand.withSubcommands([run, status, wait, watch, cancel, ls, init, worker]),
  );
};

const STATIC_AUTHORING_HELP_LINES = [
  '  agent = WHICH provider/model should do the task, e.g. codex("openai-codex/gpt-5.3-codex")',
  "  system = WHO the agent is (personality, methodology, output format)",
  "  prompt = WHAT to do now (specific files, concrete task)",
] as const;

interface DriverModelCatalogEntry {
  readonly driverName: string;
  readonly modelFormat: string;
  readonly models: ReadonlyArray<string>;
}

type ResolvedAuthoringHelp =
  | { readonly source: "static" }
  | { readonly source: "config"; readonly instructions: string };

type ResolvedModelCatalogHelp =
  | { readonly source: "resolved"; readonly entries: ReadonlyArray<DriverModelCatalogEntry> }
  | { readonly source: "unavailable"; readonly message: string };

interface ResolvedHelpContext {
  readonly authoring: ResolvedAuthoringHelp;
  readonly modelCatalog: ResolvedModelCatalogHelp;
}

const renderAuthoringHelp = (authoringHelp: ResolvedAuthoringHelp): string =>
  authoringHelp.source === "config"
    ? `Authoring:\n  ${authoringHelp.instructions}`
    : `Authoring:\n${STATIC_AUTHORING_HELP_LINES.join("\n")}`;

const renderModelCatalogHelp = (modelCatalog: ResolvedModelCatalogHelp): string => {
  if (modelCatalog.source === "unavailable") {
    return `Models:\n  (unavailable: ${modelCatalog.message})`;
  }

  if (modelCatalog.entries.length === 0) {
    return "Models:\n  (no drivers configured)";
  }

  return [
    "Models:",
    ...modelCatalog.entries.map((entry) => {
      if (entry.models.length === 0) {
        return `  ${entry.driverName} (${entry.modelFormat}): (catalog empty)`;
      }

      return `  ${entry.driverName} (${entry.modelFormat}): ${entry.models.join(", ")}`;
    }),
  ].join("\n");
};

const buildHelpText = (helpContext: ResolvedHelpContext): string =>
  `mill ${CLI_VERSION} - orchestration runtime for AI agents

Usage: mill <command> [options]

Commands:
  run <program.ts>              Run a mill program
  status <runId>                Show run state
  wait <runId> --timeout <s>    Wait for terminal state
  watch [--run <runId>]         Watch events/io streams (use --channel events|io|all)
  cancel <runId>                Cancel a running execution
  ls                            List runs
  init [--global]               Create starter config (local or ~/.mill/config.ts)

Global options: --json, --driver <name>, --runs-dir <path>

${renderModelCatalogHelp(helpContext.modelCatalog)}

Examples:

  Sequential pipeline:
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
    const security = mill.task({ agent: claude("anthropic/claude-sonnet-4-6"), prompt: "Review src/auth/" }).start();
    const perf = mill.task({ agent: codex("openai-codex/gpt-5.3-codex"), prompt: "Profile src/api/" }).start();
    const [securityResult, perfResult] = await Promise.all([security.done, perf.done]);

${renderAuthoringHelp(helpContext.authoring)}

Run mill <command> --help for details.`;

const HELP_FLAGS = new Set(["--help", "-h"]);

const COMMAND_NAMES = new Set([
  "run",
  "status",
  "wait",
  "watch",
  "cancel",
  "ls",
  "init",
  "_worker",
]);

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

const extractDriverOverride = (argv: ReadonlyArray<string>): string | undefined => {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--driver") {
      const next = argv[index + 1];
      if (next !== undefined && next.length > 0 && !next.startsWith("--")) {
        return next;
      }
      continue;
    }

    if (argument?.startsWith("--driver=") === true) {
      const value = argument.slice("--driver=".length);
      if (value.length > 0) {
        return value;
      }
    }
  }

  return undefined;
};

const resolveHelpContextForHelp = async (
  options: RunCliOptions,
  selectedDriverName?: string,
): Promise<ResolvedHelpContext> => {
  let authoring: ResolvedAuthoringHelp = {
    source: "static",
  };

  try {
    const resolvedConfig = await resolveConfig({
      defaults: resolveDefaults(options),
      cwd: options.cwd,
      homeDirectory: options.homeDirectory,
      pathExists: options.pathExists,
      loadConfigModule: options.loadConfigModule,
    });

    const instructions = resolvedConfig.config.authoring.instructions;
    const hasAuthoringOverride =
      resolvedConfig.source !== "defaults" &&
      instructions !== resolveDefaults(options).authoring.instructions;

    authoring = hasAuthoringOverride
      ? {
          source: "config",
          instructions,
        }
      : {
          source: "static",
        };

    const activeDriver = resolveActiveDriverSelection(
      selectedDriverName,
      resolvedConfig,
      options.env ?? process.env,
    );
    const registration = resolvedConfig.config.drivers[activeDriver.name];

    if (registration === undefined) {
      throw new Error(
        `Resolved active driver '${activeDriver.name}' from ${sourceLabel(activeDriver.source)} is unavailable.`,
      );
    }

    const models = await Effect.runPromise(
      Effect.map(registration.models, (catalog) => Array.from(new Set(catalog))),
    );

    return {
      authoring,
      modelCatalog: {
        source: "resolved",
        entries: [
          {
            driverName: activeDriver.name,
            modelFormat: registration.modelFormat,
            models,
          },
        ],
      },
    };
  } catch (error) {
    return {
      authoring,
      modelCatalog: {
        source: "unavailable",
        message: formatUnknownError(error),
      },
    };
  }
};

const createCliHelpFormatter = (): CliOutput.Formatter => {
  const defaultFormatter = CliOutput.defaultFormatter({ colors: false });

  return {
    ...defaultFormatter,
    formatHelpDoc: (doc) => {
      const formatted = defaultFormatter.formatHelpDoc(doc);

      if (doc.usage === "mill run [flags] <program.ts>") {
        return `$ run [--json] [--sync] [--runs-dir string] [--driver string] [--executor string] [--meta-json string] <program.ts>\n\n${formatted}`;
      }

      return formatted;
    },
  };
};

export const runCli = async (
  argv: ReadonlyArray<string>,
  options?: RunCliOptions,
): Promise<number> => {
  const resolvedOptions = options ?? {};
  const io = resolvedOptions.io ?? defaultIo;

  if (isHelpRequest(argv)) {
    const helpContext = await resolveHelpContextForHelp(
      resolvedOptions,
      extractDriverOverride(argv),
    );
    io.stdout(buildHelpText(helpContext));
    return 0;
  }

  const commandHelpRequest = isCommandHelpRequest(argv);
  const helpContext = commandHelpRequest
    ? await resolveHelpContextForHelp(resolvedOptions, extractDriverOverride(argv))
    : undefined;

  const command = createCli(resolvedOptions, io);
  const run = CliCommand.runWith(command, {
    version: CLI_VERSION,
  });

  const codeEffect = run(argv).pipe(
    Effect.as(0),
    Effect.catchTag("CliExit", (error) => Effect.succeed(error.code)),
    Effect.catchIf(
      (error): error is CliError.CliError => CliError.isCliError(error),
      (error) =>
        Effect.sync(() => {
          if (error._tag !== "ShowHelp") {
            io.stderr(formatUnknownError(error));
          }

          return error._tag === "ShowHelp" ? (error.errors.length === 0 ? 0 : 1) : 1;
        }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        io.stderr(formatUnknownError(error));
        return 1;
      }),
    ),
  );

  const exitCode = await runWithBunServices(
    Effect.provide(codeEffect, CliOutput.layer(createCliHelpFormatter())),
  );

  if (commandHelpRequest && exitCode === 0 && helpContext !== undefined) {
    if (helpContext.authoring.source === "config") {
      io.stdout(`Authoring (from config): ${helpContext.authoring.instructions}`);
    } else {
      io.stdout(`Authoring:\n${STATIC_AUTHORING_HELP_LINES.join("\n")}`);
    }

    io.stdout(renderModelCatalogHelp(helpContext.modelCatalog));
  }

  return exitCode;
};
