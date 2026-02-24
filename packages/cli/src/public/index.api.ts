import { Args, Command as CliCommand, Options, ValidationError } from "@effect/cli";
import * as PlatformCommand from "@effect/platform/Command";
import * as FileSystem from "@effect/platform/FileSystem";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Option, Runtime, Scope } from "effect";
import {
  cancelRun,
  createDiscoveryPayload,
  defineConfig,
  getRunStatus,
  inspectRun,
  listRuns,
  processDriver,
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
  defaultModel: "openai/gpt-5.3-codex",
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

const launchDetachedWorker = async (input: LaunchWorkerInput): Promise<void> => {
  const workerCommand = PlatformCommand.make(
    process.execPath,
    "run",
    millBinPath,
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
  ).pipe(
    PlatformCommand.workingDirectory(input.cwd),
    PlatformCommand.stdin("ignore"),
    PlatformCommand.stdout("ignore"),
    PlatformCommand.stderr("ignore"),
  );

  await runWithBunContext(
    Effect.gen(function* () {
      const detachedScope = yield* Scope.make();

      yield* Scope.extend(PlatformCommand.start(workerCommand), detachedScope);
    }),
  );
};

const optionalTextOption = (name: string) => Options.text(name).pipe(Options.optional);

const fromOption = <A>(value: Option.Option<A>): A | undefined =>
  Option.isSome(value) ? value.value : undefined;

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
}

const runCommand = async (
  command: RunCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
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
  'import { defineConfig, processDriver } from "@mill/core";',
  'import { createPiDriverRegistration } from "@mill/driver-pi";',
  'import { createClaudeDriverRegistration } from "@mill/driver-claude";',
  'import { createCodexDriverRegistration } from "@mill/driver-codex";',
  "",
  "export default defineConfig({",
  '  defaultDriver: "pi",',
  '  defaultExecutor: "direct",',
  '  defaultModel: "openai/gpt-5.3-codex",',
  "  drivers: {",
  "    pi: processDriver(createPiDriverRegistration()),",
  "    claude: processDriver(createClaudeDriverRegistration()),",
  "    codex: processDriver(createCodexDriverRegistration()),",
  "  },",
  "  executors: {",
  "    direct: {",
  '      description: "Local direct executor",',
  "      runtime: {",
  '        name: "direct",',
  "        runProgram: ({ execute }) => execute,",
  "      },",
  "    },",
  "    // Future: add sandboxed executors here.",
  "  },",
  "  extensions: [],",
  "  authoring: {",
  '    instructions: "Use systemPrompt for WHO and prompt for WHAT.",',
  "  },",
  "});",
].join("\n");

const initCommand = async (options: RunCliOptions, io: CliIo): Promise<number> => {
  const cwd = options.cwd ?? process.cwd();
  const configPath = `${cwd}/mill.config.ts`;

  await runWithBunContext(
    Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
      fileSystem.writeFileString(configPath, `${INIT_CONFIG_TEMPLATE}\n`),
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
  readonly runId: string;
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
    runId: command.runId,
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

interface DiscoveryCommandInput {
  readonly json: boolean;
}

const discoveryCommand = async (
  command: DiscoveryCommandInput,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const payload = await createDiscoveryPayload({
    defaults: defaultConfig,
    cwd: options.cwd,
    homeDirectory: options.homeDirectory,
    pathExists: options.pathExists,
    loadConfigModule: options.loadConfigModule,
  });

  io.stdout(command.json ? JSON.stringify(payload) : JSON.stringify(payload, null, 2));
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
      runId: Args.text({ name: "runId" }),
      json: Options.boolean("json"),
      raw: Options.boolean("raw"),
      runsDir: optionalTextOption("runs-dir"),
      driver: optionalTextOption("driver"),
    },
    (command) => toCliEffect(watchCommand(command, options, io)),
  ).pipe(CliCommand.withDescription("Stream run events."));

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

  const init = CliCommand.make("init", {}, () => toCliEffect(initCommand(options, io))).pipe(
    CliCommand.withDescription("Create a starter mill.config.ts."),
  );

  const discovery = CliCommand.make(
    "discovery",
    {
      json: Options.boolean("json"),
    },
    (command) => toCliEffect(discoveryCommand(command, options, io)),
  ).pipe(CliCommand.withDescription("Emit discovery metadata for tooling."));

  return CliCommand.make("mill").pipe(
    CliCommand.withDescription("Mill orchestration runtime."),
    CliCommand.withSubcommands([
      run,
      status,
      wait,
      watch,
      inspect,
      cancel,
      ls,
      init,
      discovery,
      worker,
    ]),
  );
};

export const runCli = async (
  argv: ReadonlyArray<string>,
  options?: RunCliOptions,
): Promise<number> => {
  const resolvedOptions = options ?? {};
  const io = resolvedOptions.io ?? defaultIo;
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

  return runWithBunContext(codeEffect);
};
