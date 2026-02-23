import {
  createDiscoveryPayload,
  defineConfig,
  getRunStatus,
  processDriver,
  runProgramSync,
  waitForRun,
  type ConfigOverrides,
} from "@mill/core";
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

const defaultIo: CliIo = {
  stdout: (line) => {
    console.log(line);
  },
  stderr: (line) => {
    console.error(line);
  },
};

const defaultConfig = defineConfig({
  defaultDriver: "default",
  defaultModel: "openai/gpt-5.3-codex",
  drivers: {
    default: processDriver(createPiDriverRegistration()),
  },
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

const runSyncCommand = async (
  argv: ReadonlyArray<string>,
  options: RunCliOptions,
  io: CliIo,
): Promise<number> => {
  const programPath = argv[0];

  if (programPath === undefined) {
    io.stderr("Usage: mill run <program.ts> --sync [--json]");
    return 1;
  }

  if (!argv.includes("--sync")) {
    io.stderr("v0 currently supports `mill run` only with --sync.");
    return 1;
  }

  const output = await runProgramSync({
    defaults: defaultConfig,
    programPath,
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

  io.stdout(`run ${output.run.id} -> ${output.run.status}`);
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
        "",
        "Run `mill --help --json` for machine-readable discovery.",
      ].join("\n"),
    );
    return 0;
  }

  if (argv[0] === "run") {
    return runSyncCommand(argv.slice(1), options ?? {}, io);
  }

  if (argv[0] === "status") {
    return statusCommand(argv.slice(1), options ?? {}, io);
  }

  if (argv[0] === "wait") {
    return waitCommand(argv.slice(1), options ?? {}, io);
  }

  io.stderr(`Unknown command: ${argv[0]}`);
  return 1;
};
