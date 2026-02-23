import * as Command from "@effect/platform/Command";
import * as FileSystem from "@effect/platform/FileSystem";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime, Scope } from "effect";
import {
  createDiscoveryPayload,
  defineConfig,
  getRunStatus,
  processDriver,
  runProgramSync,
  runWorker,
  submitRun,
  waitForRun,
  type ConfigOverrides,
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
  readonly loadConfigOverrides?: (path: string) => Promise<ConfigOverrides>;
  readonly io?: CliIo;
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

const createVmExecutor = () => ({
  description: "VM-style executor placeholder",
  runtime: {
    name: "vm",
    runProgram: (input: { readonly execute: Effect.Effect<unknown, unknown> }) => input.execute,
  },
});

const defaultConfig = defineConfig({
  defaultDriver: "default",
  defaultExecutor: "direct",
  defaultModel: "openai/gpt-5.3-codex",
  drivers: {
    default: processDriver(createPiDriverRegistration()),
    claude: processDriver(createClaudeDriverRegistration()),
    codex: processDriver(createCodexDriverRegistration()),
  },
  executors: {
    direct: createDirectExecutor(),
    vm: createVmExecutor(),
  },
  extensions: [],
  authoring: {
    instructions:
      "Use systemPrompt for WHO and prompt for WHAT. Prefer cheaper models for search and stronger models for synthesis.",
  },
});

const readFlagValue = (argv: ReadonlyArray<string>, flag: string): string | undefined => {
  const index = argv.indexOf(flag);

  if (index < 0) {
    return undefined;
  }

  return argv[index + 1];
};

const parseTimeoutSeconds = (argv: ReadonlyArray<string>): number | undefined => {
  const value = readFlagValue(argv, "--timeout");

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseFloat(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
};

const runWithBunContext = <A, E>(effect: Effect.Effect<A, E, BunContext.BunContext>): Promise<A> =>
  Runtime.runPromise(runtime)(Effect.provide(effect, BunContext.layer));

const millBinPath = decodeURIComponent(new URL("../bin/mill.ts", import.meta.url).pathname);

const launchDetachedWorker = async (input: LaunchWorkerInput): Promise<void> => {
  const workerCommand = Command.make(
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
    Command.workingDirectory(input.cwd),
    Command.stdin("inherit"),
    Command.stdout("inherit"),
    Command.stderr("inherit"),
  );

  await runWithBunContext(
    Effect.gen(function* () {
      const detachedScope = yield* Scope.make();

      yield* Scope.extend(Command.start(workerCommand), detachedScope);
    }),
  );
};

const runCommand = async (
  argv: ReadonlyArray<string>,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const programPath = argv[0];

  if (programPath === undefined) {
    io.stderr("Usage: mill run <program.ts> [--json] [--sync] [--driver] [--executor]");
    return 1;
  }

  const runInput = {
    defaults: defaultConfig,
    programPath,
    cwd: options.cwd,
    homeDirectory: options.homeDirectory,
    runsDirectory: readFlagValue(argv, "--runs-dir") ?? options.runsDirectory,
    driverName: readFlagValue(argv, "--driver"),
    executorName: readFlagValue(argv, "--executor"),
    pathExists: options.pathExists,
    loadConfigOverrides: options.loadConfigOverrides,
    launchWorker: launchDetachedWorker,
  } as const;

  if (argv.includes("--sync")) {
    const output = await runProgramSync(runInput);

    if (argv.includes("--json")) {
      io.stdout(JSON.stringify(output));
      return 0;
    }

    io.stdout(`run ${output.run.id} -> ${output.run.status}`);
    return 0;
  }

  const submittedRun = await submitRun(runInput);

  if (argv.includes("--json")) {
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

const workerCommand = async (
  argv: ReadonlyArray<string>,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const runId = readFlagValue(argv, "--run-id");
  const programPath = readFlagValue(argv, "--program");

  if (runId === undefined || programPath === undefined) {
    io.stderr(
      "Usage: mill _worker --run-id <id> --program <abs-path> [--runs-dir] [--driver] [--executor]",
    );
    return 1;
  }

  const output = await runWorker({
    defaults: defaultConfig,
    runId,
    programPath,
    cwd: options.cwd,
    homeDirectory: options.homeDirectory,
    runsDirectory: readFlagValue(argv, "--runs-dir") ?? options.runsDirectory,
    driverName: readFlagValue(argv, "--driver"),
    executorName: readFlagValue(argv, "--executor"),
    pathExists: options.pathExists,
    loadConfigOverrides: options.loadConfigOverrides,
  });

  if (argv.includes("--json")) {
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
  '  defaultDriver: "default",',
  '  defaultExecutor: "direct",',
  '  defaultModel: "openai/gpt-5.3-codex",',
  "  drivers: {",
  "    default: processDriver(createPiDriverRegistration()),",
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
  "    vm: {",
  '      description: "VM-style executor placeholder",',
  "      runtime: {",
  '        name: "vm",',
  "        runProgram: ({ execute }) => execute,",
  "      },",
  "    },",
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

const statusCommand = async (
  argv: ReadonlyArray<string>,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const runId = argv[0];

  if (runId === undefined) {
    io.stderr("Usage: mill status <runId> [--json]");
    return 1;
  }

  const output = await getRunStatus({
    defaults: defaultConfig,
    runId,
    cwd: options.cwd,
    homeDirectory: options.homeDirectory,
    runsDirectory: readFlagValue(argv, "--runs-dir") ?? options.runsDirectory,
    driverName: readFlagValue(argv, "--driver"),
    pathExists: options.pathExists,
    loadConfigOverrides: options.loadConfigOverrides,
  });

  if (argv.includes("--json")) {
    io.stdout(JSON.stringify(output));
    return 0;
  }

  io.stdout(`run ${output.id} status=${output.status}`);
  return 0;
};

const waitCommand = async (
  argv: ReadonlyArray<string>,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const runId = argv[0];
  const timeoutSeconds = parseTimeoutSeconds(argv);
  const isJson = argv.includes("--json");

  if (runId === undefined || timeoutSeconds === undefined) {
    io.stderr("Usage: mill wait <runId> --timeout <seconds> [--json]");
    return 1;
  }

  const [waitResult] = await Promise.allSettled([
    waitForRun({
      defaults: defaultConfig,
      runId,
      timeoutSeconds,
      cwd: options.cwd,
      homeDirectory: options.homeDirectory,
      runsDirectory: readFlagValue(argv, "--runs-dir") ?? options.runsDirectory,
      driverName: readFlagValue(argv, "--driver"),
      pathExists: options.pathExists,
      loadConfigOverrides: options.loadConfigOverrides,
    }),
  ]);

  if (waitResult.status === "fulfilled") {
    if (isJson) {
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
    const message = `Timeout waiting for run ${runId} after ${timeoutSeconds}s.`;

    if (isJson) {
      io.stdout(
        JSON.stringify({
          ok: false,
          error: {
            _tag: "WaitTimeoutError",
            runId,
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

  if (isJson) {
    io.stdout(
      JSON.stringify({
        ok: false,
        error: {
          _tag: "WaitError",
          runId,
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

export const runCli = async (
  argv: ReadonlyArray<string>,
  options?: RunCliOptions,
): Promise<number> => {
  const io = options?.io ?? defaultIo;
  const showHelp = argv.length === 0 || argv.includes("--help");

  if (showHelp) {
    const payload = await createDiscoveryPayload({
      defaults: defaultConfig,
      cwd: options?.cwd,
      homeDirectory: options?.homeDirectory,
      pathExists: options?.pathExists,
      loadConfigOverrides: options?.loadConfigOverrides,
    });

    if (argv.includes("--json")) {
      io.stdout(JSON.stringify(payload));
      return 0;
    }

    io.stdout(
      [
        "mill — Effect-first orchestration runtime",
        "",
        `Authoring guidance: ${payload.authoring.instructions}`,
        `Registered drivers: ${Object.keys(payload.drivers).join(", ")}`,
        `Registered executors: ${Object.keys(payload.executors).join(", ")}`,
        "",
        "Run `mill --help --json` for machine-readable discovery.",
      ].join("\n"),
    );
    return 0;
  }

  if (argv[0] === "run") {
    return runCommand(argv.slice(1), options ?? {}, io);
  }

  if (argv[0] === "_worker") {
    return workerCommand(argv.slice(1), options ?? {}, io);
  }

  if (argv[0] === "status") {
    return statusCommand(argv.slice(1), options ?? {}, io);
  }

  if (argv[0] === "wait") {
    return waitCommand(argv.slice(1), options ?? {}, io);
  }

  if (argv[0] === "init") {
    return initCommand(options ?? {}, io);
  }

  io.stderr(`Unknown command: ${argv[0]}`);
  return 1;
};
