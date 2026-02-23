import {
  createDiscoveryPayload,
  defineConfig,
  processDriver,
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

  io.stderr("v0 scaffold: only help/discovery is wired in this foundation stage.");
  return 0;
};
