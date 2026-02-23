import * as FileSystem from "@effect/platform/FileSystem";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect, Runtime } from "effect";
import type {
  ConfigOverrides,
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

const extractConfigString = (source: string, key: string): string | undefined => {
  const match = new RegExp(`${key}\\s*:\\s*["']([^"'\\n]+)["']`).exec(source);
  return match?.[1];
};

const extractConstStringValue = (source: string, identifier: string): string | undefined => {
  const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const directStringMatch = new RegExp(
    `const\\s+${escapedIdentifier}\\s*=\\s*(["'\\"])(([\\s\\S]*?))\\1\\s*;?`,
  ).exec(source);

  if (directStringMatch !== null) {
    return directStringMatch[2];
  }

  const joinedArrayMatch = new RegExp(
    `const\\s+${escapedIdentifier}\\s*=\\s*\\[([\\s\\S]*?)\\]\\.join\\((["'])((?:[\\s\\S]*?))\\2\\)\\s*;?`,
  ).exec(source);

  if (joinedArrayMatch === null) {
    return undefined;
  }

  const values = Array.from(joinedArrayMatch[1].matchAll(/["'`]([^"'`]+)["'`]/g)).map(
    (match) => match[1],
  );

  if (values.length === 0) {
    return undefined;
  }

  return values.join(joinedArrayMatch[3]);
};

const extractAuthoringInstructions = (source: string): string | undefined => {
  const directInstructions = extractConfigString(source, "instructions");

  if (directInstructions !== undefined) {
    return directInstructions;
  }

  const authoringBlockMatch = /authoring\s*:\s*\{([\s\S]*?)\}/.exec(source);

  if (authoringBlockMatch === null) {
    return undefined;
  }

  const authoringBlock = authoringBlockMatch[1];
  const explicitIdentifierMatch = /instructions\s*:\s*([A-Za-z_$][\w$]*)/.exec(authoringBlock);

  if (explicitIdentifierMatch !== null) {
    return extractConstStringValue(source, explicitIdentifierMatch[1]);
  }

  const hasShorthandInstructions = /\binstructions\b\s*(?:,|$)/.test(authoringBlock);

  if (!hasShorthandInstructions) {
    return undefined;
  }

  return extractConstStringValue(source, "instructions");
};

const parseConfigOverridesFromText = (source: string): ConfigOverrides => ({
  defaultDriver: extractConfigString(source, "defaultDriver"),
  defaultExecutor: extractConfigString(source, "defaultExecutor"),
  defaultModel: extractConfigString(source, "defaultModel"),
  authoringInstructions: extractAuthoringInstructions(source),
});

const readConfigSource = async (path: string): Promise<string> =>
  runWithBunContext(
    Effect.catchAll(
      Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(path, "utf-8"),
      ),
      () => Effect.succeed(""),
    ),
  );

const defaultLoadConfigOverrides = async (path: string): Promise<ConfigOverrides> => {
  const source = await readConfigSource(path);

  return parseConfigOverridesFromText(source);
};

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

const mergeConfig = (defaults: MillConfig, overrides: ConfigOverrides): MillConfig => ({
  ...defaults,
  defaultDriver: overrides.defaultDriver ?? defaults.defaultDriver,
  defaultExecutor: overrides.defaultExecutor ?? defaults.defaultExecutor,
  defaultModel: overrides.defaultModel ?? defaults.defaultModel,
  authoring: {
    instructions: overrides.authoringInstructions ?? defaults.authoring.instructions,
  },
});

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

export const defineConfig = <T extends MillConfig>(config: T): T => config;

export const processDriver = <T extends DriverRegistration>(driver: T): T => driver;

export const resolveConfig = async (options: ResolveConfigOptions): Promise<ResolvedConfig> => {
  const cwd = options.cwd ?? process.cwd();
  const homeDirectory = options.homeDirectory ?? process.env.HOME;
  const pathExists = options.pathExists ?? defaultPathExists;
  const loadConfigOverrides = options.loadConfigOverrides ?? defaultLoadConfigOverrides;

  const resolvedPath = await resolveConfigPath(cwd, homeDirectory, pathExists);

  if (resolvedPath === undefined) {
    return {
      source: "defaults",
      config: options.defaults,
    };
  }

  const overrides = await loadConfigOverrides(resolvedPath.path);

  return {
    source: resolvedPath.source,
    configPath: resolvedPath.path,
    config: mergeConfig(options.defaults, overrides),
  };
};
