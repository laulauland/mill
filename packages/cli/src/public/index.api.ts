import { Args, CliConfig, Command as CliCommand, Options, ValidationError } from "@effect/cli";
import * as PlatformCommand from "@effect/platform/Command";
import * as FileSystem from "@effect/platform/FileSystem";
import * as BunContext from "@effect/platform-bun/BunContext";
import * as Schema from "@effect/schema/Schema";
import { Effect, Option, Runtime, Scope } from "effect";
import {
  cancelRun,
  defineConfig,
  getRunStatus,
  inspectRun,
  listRuns,
  processDriver,
  resolveConfig,
  runProgramSync,
  runWorker,
  submitRun,
  waitForRun,
  watchRun,
  type LaunchWorkerInput,
} from "@mill/core";
import { createClaudeDriverRegistration } from "@mill/driver-claude";
import { createCodexDriverRegistration } from "@mill/driver-codex";
import { createPiDriverRegistration } from "@mill/driver-pi";

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
}

interface CliExit {
  readonly _tag: "CliExit";
  readonly code: number;
}

const runtime = Runtime.defaultRuntime;

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

const defaultConfig = defineConfig({
  defaultDriver: "pi",
  defaultExecutor: "direct",
  defaultModel: "openai-codex/gpt-5.3-codex",
  drivers: {
    pi: processDriver(createPiDriverRegistration()),
    claude: processDriver(createClaudeDriverRegistration()),
    codex: processDriver(createCodexDriverRegistration()),
  },
  executors: {
    direct: createDirectExecutor(),
  },
  extensions: [],
  authoring: {
    instructions:
      "Use systemPrompt for WHO and prompt for WHAT. Prefer cheaper models for search and stronger models for synthesis.",
  },
});

const runWithBunContext = <A, E>(effect: Effect.Effect<A, E, BunContext.BunContext>): Promise<A> =>
  Runtime.runPromise(runtime)(Effect.provide(effect, BunContext.layer));

const millBinPath = decodeURIComponent(new URL("../bin/mill.ts", import.meta.url).pathname);

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

const buildWorkerCommandArguments = (
  hasSourceEntrypoint: boolean,
  input: LaunchWorkerInput,
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

  return hasSourceEntrypoint ? ["run", millBinPath, ...workerArguments] : workerArguments;
};

const launchDetachedWorker = async (input: LaunchWorkerInput): Promise<void> => {
  await runWithBunContext(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const hasSourceEntrypoint = yield* fileSystem.exists(millBinPath);

      const workerCommand = PlatformCommand.make(
        process.execPath,
        ...buildWorkerCommandArguments(hasSourceEntrypoint, input),
      ).pipe(
        PlatformCommand.workingDirectory(input.cwd),
        PlatformCommand.stdin("ignore"),
        PlatformCommand.stdout("ignore"),
        PlatformCommand.stderr("ignore"),
      );

      const detachedScope = yield* Scope.make();
      const processHandle = yield* Scope.extend(
        PlatformCommand.start(workerCommand),
        detachedScope,
      );
      const pidPath = workerPidPath(input.runsDirectory, input.runId);
      const runDirectory = pidPath.slice(0, pidPath.lastIndexOf("/"));

      yield* fileSystem.makeDirectory(runDirectory, { recursive: true });
      yield* fileSystem.writeFileString(pidPath, `${Number(processHandle.pid)}\n`);
    }),
  );
};

const optionalTextOption = (name: string) => Options.text(name).pipe(Options.optional);

const fromOption = <A>(value: Option.Option<A>): A | undefined =>
  Option.isSome(value) ? value.value : undefined;

const MetadataJson = Schema.parseJson(
  Schema.Record({
    key: Schema.String,
    value: Schema.String,
  }),
);

const parseMetadataJson = (raw: string): Readonly<Record<string, string>> | undefined => {
  const parsed = Schema.decodeUnknownSync(MetadataJson)(raw);

  if (Object.keys(parsed).length === 0) {
    return undefined;
  }

  return parsed;
};

const toCliEffect = (program: Promise<number>) =>
  Effect.flatMap(
    Effect.promise(() => program),
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

  const runInput = {
    defaults: defaultConfig,
    programPath: command.program,
    cwd: options.cwd,
    homeDirectory: options.homeDirectory,
    runsDirectory: fromOption(command.runsDir) ?? options.runsDirectory,
    driverName: fromOption(command.driver),
    executorName: fromOption(command.executor),
    pathExists: options.pathExists,
    loadConfigModule: options.loadConfigModule,
    launchWorker: options.launchWorker ?? launchDetachedWorker,
    metadata,
  } as const;

  if (command.sync) {
    const output = await runProgramSync(runInput);

    if (command.json) {
      io.stdout(JSON.stringify(output));
      return 0;
    }

    io.stdout(`run ${output.run.id} -> ${output.run.status}`);
    return 0;
  }

  const submittedRun = await submitRun(runInput);

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
  const output = await runWorker({
    defaults: defaultConfig,
    runId: command.runId,
    programPath: command.program,
    cwd: options.cwd,
    homeDirectory: options.homeDirectory,
    runsDirectory: fromOption(command.runsDir) ?? options.runsDirectory,
    driverName: fromOption(command.driver),
    executorName: fromOption(command.executor),
    pathExists: options.pathExists,
    loadConfigModule: options.loadConfigModule,
  });

  if (command.json) {
    io.stdout(JSON.stringify(output));
  }

  return 0;
};

const INIT_CONFIG_TEMPLATE = [
  "export default {",
  "  // Optional: override model/driver/executor defaults.",
  '  // defaultModel: "openai-codex/gpt-5.3-codex",',
  "  authoring: {",
  '    instructions: "Use systemPrompt for WHO (role/method), prompt for WHAT (explicit task + scope + validation). Prefer codex for synthesis, cerebras for fast retrieval.",',
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

  await runWithBunContext(
    Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
      Effect.zipRight(
        fileSystem.makeDirectory(dirname(configPath), { recursive: true }),
        fileSystem.writeFileString(configPath, `${INIT_CONFIG_TEMPLATE}\n`),
      ),
    ),
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
  const output = await getRunStatus({
    defaults: defaultConfig,
    runId: command.runId,
    cwd: options.cwd,
    homeDirectory: options.homeDirectory,
    runsDirectory: fromOption(command.runsDir) ?? options.runsDirectory,
    driverName: fromOption(command.driver),
    pathExists: options.pathExists,
    loadConfigModule: options.loadConfigModule,
  });

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

  const [waitResult] = await Promise.allSettled([
    waitForRun({
      defaults: defaultConfig,
      runId: command.runId,
      timeoutSeconds,
      cwd: options.cwd,
      homeDirectory: options.homeDirectory,
      runsDirectory: fromOption(command.runsDir) ?? options.runsDirectory,
      driverName: fromOption(command.driver),
      pathExists: options.pathExists,
      loadConfigModule: options.loadConfigModule,
    }),
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

interface WatchCommandInput {
  readonly run: Option.Option<string>;
  readonly sinceTime: Option.Option<string>;
  readonly json: boolean;
  readonly raw: boolean;
  readonly runsDir: Option.Option<string>;
  readonly driver: Option.Option<string>;
}

const watchCommand = async (
  command: WatchCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  await watchRun({
    defaults: defaultConfig,
    runId: fromOption(command.run),
    sinceTimeIso: fromOption(command.sinceTime),
    raw: command.raw,
    cwd: options.cwd,
    homeDirectory: options.homeDirectory,
    runsDirectory: fromOption(command.runsDir) ?? options.runsDirectory,
    driverName: fromOption(command.driver),
    pathExists: options.pathExists,
    loadConfigModule: options.loadConfigModule,
    onEvent: (line) => {
      io.stdout(line);
    },
  });

  return 0;
};

interface InspectCommandInput {
  readonly ref: string;
  readonly json: boolean;
  readonly session: boolean;
  readonly runsDir: Option.Option<string>;
  readonly driver: Option.Option<string>;
}

const inspectCommand = async (
  command: InspectCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const inspected = await inspectRun({
    defaults: defaultConfig,
    ref: command.ref,
    session: command.session,
    cwd: options.cwd,
    homeDirectory: options.homeDirectory,
    runsDirectory: fromOption(command.runsDir) ?? options.runsDirectory,
    driverName: fromOption(command.driver),
    pathExists: options.pathExists,
    loadConfigModule: options.loadConfigModule,
  });

  if (command.json) {
    io.stdout(JSON.stringify(inspected));
    return 0;
  }

  io.stdout(JSON.stringify(inspected, null, 2));
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
  const cancelled = await cancelRun({
    defaults: defaultConfig,
    runId: command.runId,
    cwd: options.cwd,
    homeDirectory: options.homeDirectory,
    runsDirectory: fromOption(command.runsDir) ?? options.runsDirectory,
    driverName: fromOption(command.driver),
    pathExists: options.pathExists,
    loadConfigModule: options.loadConfigModule,
  });

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
  const runs = await listRuns({
    defaults: defaultConfig,
    status: fromOption(command.status),
    cwd: options.cwd,
    homeDirectory: options.homeDirectory,
    runsDirectory: fromOption(command.runsDir) ?? options.runsDirectory,
    driverName: fromOption(command.driver),
    pathExists: options.pathExists,
    loadConfigModule: options.loadConfigModule,
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
      program: Args.text({ name: "program.ts" }),
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
      runId: Options.text("run-id"),
      program: Options.text("program"),
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
      runId: Args.text({ name: "runId" }),
      json: Options.boolean("json"),
      runsDir: optionalTextOption("runs-dir"),
      driver: optionalTextOption("driver"),
    },
    (command) => toCliEffect(statusCommand(command, options, io)),
  ).pipe(CliCommand.withDescription("Read the current run status."));

  const wait = CliCommand.make(
    "wait",
    {
      runId: Args.text({ name: "runId" }),
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
      json: Options.boolean("json"),
      raw: Options.boolean("raw"),
      runsDir: optionalTextOption("runs-dir"),
      driver: optionalTextOption("driver"),
    },
    (command) => toCliEffect(watchCommand(command, options, io)),
  ).pipe(
    CliCommand.withDescription(
      "Stream run events. Use --run <runId> for scoped watch, omit for global watch.",
    ),
  );

  const inspect = CliCommand.make(
    "inspect",
    {
      ref: Args.text({ name: "runId[.spawnId]" }),
      json: Options.boolean("json"),
      session: Options.boolean("session"),
      runsDir: optionalTextOption("runs-dir"),
      driver: optionalTextOption("driver"),
    },
    (command) => toCliEffect(inspectCommand(command, options, io)),
  ).pipe(CliCommand.withDescription("Inspect run, spawn, or session output."));

  const cancel = CliCommand.make(
    "cancel",
    {
      runId: Args.text({ name: "runId" }),
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
    CliCommand.withSubcommands([run, status, wait, watch, inspect, cancel, ls, init, worker]),
  );
};

const STATIC_AUTHORING_HELP_LINES = [
  "  systemPrompt = WHO the agent is (personality, methodology, output format)",
  "  prompt       = WHAT to do now (specific files, concrete task)",
] as const;

type ResolvedAuthoringHelp =
  | { readonly source: "static" }
  | { readonly source: "config"; readonly instructions: string };

const renderAuthoringHelp = (authoringHelp: ResolvedAuthoringHelp): string =>
  authoringHelp.source === "config"
    ? `Authoring:\n  ${authoringHelp.instructions}`
    : `Authoring:\n${STATIC_AUTHORING_HELP_LINES.join("\n")}`;

const buildHelpText = (authoringHelp: ResolvedAuthoringHelp): string =>
  `mill - orchestration runtime for AI agents

Usage: mill <command> [options]

Commands:
  run <program.ts>              Run a mill program
  status <runId>                Show run state
  wait <runId> --timeout <s>    Wait for terminal state
  watch [--run <runId>]         Stream run events (global if --run omitted)
  inspect <ref>                 Inspect run or spawn detail
  cancel <runId>                Cancel a running execution
  ls                            List runs
  init [--global]               Create starter config (local or ~/.mill/config.ts)

Global options: --json, --driver <name>, --runs-dir <path>

Examples:

  Sequential pipeline:
    const scan = await mill.spawn({
      agent: "scout",
      systemPrompt: "You are a code risk analyst.",
      prompt: "Review src/auth and summarize top security risks.",
    });
    const plan = await mill.spawn({
      agent: "planner",
      systemPrompt: "You turn findings into an execution-ready plan.",
      prompt: \`Create remediation steps from:\\n\\n\${scan.text}\`,
    });

  Parallel fan-out:
    const [security, perf] = await Promise.all([
      mill.spawn({ agent: "security", systemPrompt: "...", prompt: "Review src/auth/" }),
      mill.spawn({ agent: "perf", systemPrompt: "...", prompt: "Profile src/api/" }),
    ]);

${renderAuthoringHelp(authoringHelp)}

Run mill <command> --help for details.`;

const HELP_FLAGS = new Set(["--help", "-h"]);

const COMMAND_NAMES = new Set([
  "run",
  "status",
  "wait",
  "watch",
  "inspect",
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

const resolveAuthoringHelpForHelp = async (
  options: RunCliOptions,
): Promise<ResolvedAuthoringHelp> => {
  try {
    const resolvedConfig = await resolveConfig({
      defaults: defaultConfig,
      cwd: options.cwd,
      homeDirectory: options.homeDirectory,
      pathExists: options.pathExists,
      loadConfigModule: options.loadConfigModule,
    });

    const instructions = resolvedConfig.config.authoring.instructions;
    const hasAuthoringOverride =
      resolvedConfig.source !== "defaults" && instructions !== defaultConfig.authoring.instructions;

    if (hasAuthoringOverride) {
      return {
        source: "config",
        instructions,
      };
    }
  } catch {
    // fall through to static authoring help
  }

  return {
    source: "static",
  };
};

export const runCli = async (
  argv: ReadonlyArray<string>,
  options?: RunCliOptions,
): Promise<number> => {
  const resolvedOptions = options ?? {};
  const io = resolvedOptions.io ?? defaultIo;

  if (isHelpRequest(argv)) {
    const authoringHelp = await resolveAuthoringHelpForHelp(resolvedOptions);
    io.stdout(buildHelpText(authoringHelp));
    return 0;
  }

  const commandHelpRequest = isCommandHelpRequest(argv);
  const authoringHelp = commandHelpRequest
    ? await resolveAuthoringHelpForHelp(resolvedOptions)
    : undefined;

  const command = createCli(resolvedOptions, io);
  const run = CliCommand.run(command, {
    name: "mill",
    version: "0.0.0",
    executable: "mill",
  });

  const codeEffect = run([process.execPath, millBinPath, ...argv]).pipe(
    Effect.as(0),
    Effect.catchTag("CliExit", (error) => Effect.succeed(error.code)),
    Effect.catchIf(ValidationError.isValidationError, () => Effect.succeed(1)),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        io.stderr(formatUnknownError(error));
        return 1;
      }),
    ),
  );

  const compactHelp = CliConfig.layer({ showBuiltIns: false, showTypes: false });
  const exitCode = await runWithBunContext(Effect.provide(codeEffect, compactHelp));

  if (commandHelpRequest && exitCode === 0 && authoringHelp !== undefined) {
    if (authoringHelp.source === "config") {
      io.stdout(`Authoring (from config): ${authoringHelp.instructions}`);
    } else {
      io.stdout(`Authoring:\n${STATIC_AUTHORING_HELP_LINES.join("\n")}`);
    }
  }

  return exitCode;
};
