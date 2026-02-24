import * as FileSystem from "@effect/platform/FileSystem";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime } from "effect";
import type {
  ConfigFileOverrides,
  DriverRegistration,
  MillConfig,
  ResolvedConfig,
  ResolveConfigOptions,
} from "./types";

const runtime = Runtime.defaultRuntime;

const CONFIG_FILE_NAME = "mill.config.ts";
const HOME_CONFIG_PATH = ".mill/config.ts";

const runWithBunContext = <A, E>(effect: Effect.Effect<A, E, BunContext.BunContext>): Promise<A> =>
  Runtime.runPromise(runtime)(Effect.provide(effect, BunContext.layer));

const defaultPathExists = async (path: string): Promise<boolean> =>
  runWithBunContext(Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.exists(path)));

const normalizePath = (path: string): string => {
  if (path.length <= 1) {
    return path;
  }
  return path.endsWith("/") ? path.slice(0, -1) : path;
};

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

const joinPath = (base: string, child: string): string =>
  normalizePath(base) === "/" ? `/${child}` : `${normalizePath(base)}/${child}`;

const findRepoRoot = async (
  startDirectory: string,
  pathExists: (path: string) => Promise<boolean>,
): Promise<string | undefined> => {
  let current = normalizePath(startDirectory);

  while (true) {
    const isJjRepoRoot = await pathExists(joinPath(current, ".jj"));
    const isGitRepoRoot = await pathExists(joinPath(current, ".git"));

    if (isJjRepoRoot || isGitRepoRoot) {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
};

const resolveConfigPath = async (
  cwd: string,
  homeDirectory: string | undefined,
  pathExists: (path: string) => Promise<boolean>,
): Promise<{ source: "cwd" | "upward" | "home"; path: string } | undefined> => {
  const normalizedCwd = normalizePath(cwd);
  const cwdConfig = joinPath(normalizedCwd, CONFIG_FILE_NAME);

  if (await pathExists(cwdConfig)) {
    return {
      source: "cwd",
      path: cwdConfig,
    };
  }

  const repoRoot = await findRepoRoot(normalizedCwd, pathExists);

  if (repoRoot !== undefined) {
    let current = repoRoot === normalizedCwd ? normalizedCwd : dirname(normalizedCwd);

    while (current !== normalizedCwd) {
      const candidate = joinPath(current, CONFIG_FILE_NAME);

      if (await pathExists(candidate)) {
        return {
          source: "upward",
          path: candidate,
        };
      }

      if (current === repoRoot) {
        break;
      }

      const parent = dirname(current);

      if (parent === current) {
        break;
      }

      current = parent;
    }
  }

  if (homeDirectory !== undefined && homeDirectory.length > 0) {
    const homeConfig = joinPath(homeDirectory, HOME_CONFIG_PATH);

    if (await pathExists(homeConfig)) {
      return {
        source: "home",
        path: homeConfig,
      };
    }
  }

  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasConfigShape = (value: Record<string, unknown>): boolean =>
  [
    "defaultDriver",
    "defaultExecutor",
    "defaultModel",
    "drivers",
    "executors",
    "extensions",
    "authoring",
  ].some((key) => key in value);

const readRecordField = (
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  const field = value[key];

  if (!isRecord(field)) {
    return undefined;
  }

  return field;
};

const readStringField = (value: Record<string, unknown>, key: string): string | undefined => {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
};

const toConfigOverrides = (value: Record<string, unknown>): ConfigFileOverrides => {
  const authoringRecord = readRecordField(value, "authoring");

  return {
    defaultDriver: readStringField(value, "defaultDriver"),
    defaultExecutor: readStringField(value, "defaultExecutor"),
    defaultModel: readStringField(value, "defaultModel"),
    drivers: readRecordField(value, "drivers") as Readonly<Record<string, DriverRegistration>>,
    executors: readRecordField(value, "executors") as MillConfig["executors"],
    extensions: Array.isArray(value.extensions)
      ? (value.extensions as MillConfig["extensions"])
      : undefined,
    authoring: {
      instructions:
        authoringRecord === undefined
          ? undefined
          : readStringField(authoringRecord, "instructions"),
    },
  };
};

const toModuleSpecifier = (path: string, cwd: string): string => {
  if (path.startsWith("file://")) {
    return path;
  }

  if (path.startsWith("/")) {
    return new URL(path, "file://").href;
  }

  return new URL(path, `file://${normalizePath(cwd)}/`).href;
};

const defaultLoadConfigModule = async (path: string): Promise<unknown> => {
  const moduleSpecifier = toModuleSpecifier(path, process.cwd());
  // ast-grep-ignore: no-dynamic-import
  return import(moduleSpecifier);
};

const extractConfigFromModule = (moduleValue: unknown): ConfigFileOverrides | undefined => {
  if (!isRecord(moduleValue)) {
    return undefined;
  }

  const candidateValues: ReadonlyArray<unknown> = [
    moduleValue.default,
    moduleValue.config,
    moduleValue.millConfig,
    moduleValue,
  ];

  for (const candidate of candidateValues) {
    if (!isRecord(candidate) || !hasConfigShape(candidate)) {
      continue;
    }

    return toConfigOverrides(candidate);
  }

  return undefined;
};

const mergeConfig = (defaults: MillConfig, overrides: ConfigFileOverrides): MillConfig => ({
  ...defaults,
  defaultDriver: overrides.defaultDriver ?? defaults.defaultDriver,
  defaultExecutor: overrides.defaultExecutor ?? defaults.defaultExecutor,
  defaultModel: overrides.defaultModel ?? defaults.defaultModel,
  drivers: {
    ...defaults.drivers,
    ...overrides.drivers,
  },
  executors: {
    ...defaults.executors,
    ...overrides.executors,
  },
  extensions: overrides.extensions ?? defaults.extensions,
  authoring: {
    instructions: overrides.authoring?.instructions ?? defaults.authoring.instructions,
  },
});

export const defineConfig = <T extends MillConfig>(config: T): T => config;

export const processDriver = <T extends DriverRegistration>(driver: T): T => driver;

export const resolveConfig = async (options: ResolveConfigOptions): Promise<ResolvedConfig> => {
  const cwd = options.cwd ?? process.cwd();
  const homeDirectory = options.homeDirectory ?? process.env.HOME;
  const pathExists = options.pathExists ?? defaultPathExists;
  const loadConfigModule = options.loadConfigModule ?? defaultLoadConfigModule;

  const resolvedPath = await resolveConfigPath(cwd, homeDirectory, pathExists);

  if (resolvedPath === undefined) {
    return {
      source: "defaults",
      config: options.defaults,
    };
  }

  const loadedModule = await loadConfigModule(resolvedPath.path);
  const loadedConfig = extractConfigFromModule(loadedModule);

  return {
    source: resolvedPath.source,
    configPath: resolvedPath.path,
    config:
      loadedConfig === undefined ? options.defaults : mergeConfig(options.defaults, loadedConfig),
  };
};
