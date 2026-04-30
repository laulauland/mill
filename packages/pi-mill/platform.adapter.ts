import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Config, ConfigProvider, Data, Effect, Option } from "effect";
import * as FileSystem from "effect/FileSystem";

export class PiMillFileError extends Data.TaggedError("PiMillFileError")<{
  readonly operation:
    | "read"
    | "write"
    | "append"
    | "mkdir"
    | "remove"
    | "list"
    | "stat"
    | "exists"
    | "copy"
    | "mktemp";
  readonly path: string;
  readonly cause: unknown;
}> {}

export const provideFileSystem = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  effect.pipe(Effect.provide(BunFileSystem.layer));

const trimTrailingSlashes = (value: string): string => {
  const trimmed = value.replace(/\/+$/g, "");
  return trimmed.length === 0 ? "/" : trimmed;
};

const normalizePath = (value: string): string => {
  const absolute = value.startsWith("/");
  const segments: string[] = [];
  for (const part of value.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      const previous = segments.at(-1);
      if (previous !== undefined && previous !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push(part);
      }
      continue;
    }
    segments.push(part);
  }
  const joined = `${absolute ? "/" : ""}${segments.join("/")}`;
  return joined.length === 0 ? (absolute ? "/" : ".") : joined;
};

export const path = {
  join: (...parts: ReadonlyArray<string>): string => normalizePath(parts.filter(Boolean).join("/")),
  dirname: (value: string): string => {
    const normalized = trimTrailingSlashes(normalizePath(value));
    if (normalized === "/") return "/";
    const index = normalized.lastIndexOf("/");
    if (index < 0) return ".";
    if (index === 0) return "/";
    return normalized.slice(0, index);
  },
  basename: (value: string): string => {
    const normalized = trimTrailingSlashes(normalizePath(value));
    if (normalized === "/") return "/";
    const index = normalized.lastIndexOf("/");
    return index < 0 ? normalized : normalized.slice(index + 1);
  },
} as const;

export const fileURLToPath = (url: string | URL): string => {
  const parsed = typeof url === "string" ? new URL(url) : url;
  return decodeURIComponent(parsed.pathname);
};

export const pathToFileURL = (filePath: string): URL => new URL(`file://${encodeURI(filePath)}`);

export const homeDirectory = (): string =>
  Effect.runSync(
    Effect.map(Config.string("HOME").pipe(Config.option).parse(ConfigProvider.fromEnv()), (value) =>
      Option.getOrElse(value, () => ""),
    ),
  );

export const temporaryDirectory = (): string =>
  Effect.runSync(
    Effect.map(
      Config.string("TMPDIR").pipe(Config.option).parse(ConfigProvider.fromEnv()),
      (value) => Option.getOrElse(value, () => "/tmp"),
    ),
  );

export const currentWorkingDirectory = (): string => ".";

export const nodeExecutablePath = (): string => process.execPath;

export const readTextFile = (
  filePath: string,
): Effect.Effect<string, PiMillFileError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem
      .readFileString(filePath, "utf-8")
      .pipe(
        Effect.mapError(
          (cause) => new PiMillFileError({ operation: "read", path: filePath, cause }),
        ),
      );
  });

export const writeTextFile = (
  filePath: string,
  content: string,
  mode?: number,
): Effect.Effect<void, PiMillFileError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .writeFileString(filePath, content, mode === undefined ? undefined : { mode })
      .pipe(
        Effect.mapError(
          (cause) => new PiMillFileError({ operation: "write", path: filePath, cause }),
        ),
      );
  });

export const appendTextFile = (
  filePath: string,
  content: string,
): Effect.Effect<void, PiMillFileError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .writeFileString(filePath, content, { flag: "a" })
      .pipe(
        Effect.mapError(
          (cause) => new PiMillFileError({ operation: "append", path: filePath, cause }),
        ),
      );
  });

export const makeTemporaryDirectory = (
  prefixPath: string,
): Effect.Effect<string, PiMillFileError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem
      .makeTempDirectory({ directory: path.dirname(prefixPath), prefix: path.basename(prefixPath) })
      .pipe(
        Effect.mapError(
          (cause) => new PiMillFileError({ operation: "mktemp", path: prefixPath, cause }),
        ),
      );
  });

export const copyFile = (
  source: string,
  target: string,
): Effect.Effect<void, PiMillFileError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .copyFile(source, target)
      .pipe(
        Effect.mapError((cause) => new PiMillFileError({ operation: "copy", path: target, cause })),
      );
  });

export const pathExists = (
  filePath: string,
): Effect.Effect<boolean, PiMillFileError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem
      .exists(filePath)
      .pipe(
        Effect.mapError(
          (cause) => new PiMillFileError({ operation: "exists", path: filePath, cause }),
        ),
      );
  });

export const ensureDirectory = (
  dirPath: string,
): Effect.Effect<void, PiMillFileError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .makeDirectory(dirPath, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new PiMillFileError({ operation: "mkdir", path: dirPath, cause }),
        ),
      );
  });

export const removePath = (
  filePath: string,
): Effect.Effect<void, PiMillFileError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .remove(filePath, { recursive: true, force: true })
      .pipe(
        Effect.mapError(
          (cause) => new PiMillFileError({ operation: "remove", path: filePath, cause }),
        ),
      );
  });

export const isDirectory = (
  filePath: string,
): Effect.Effect<boolean, PiMillFileError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stats = yield* fileSystem
      .stat(filePath)
      .pipe(
        Effect.mapError(
          (cause) => new PiMillFileError({ operation: "stat", path: filePath, cause }),
        ),
      );
    return stats.type === "Directory";
  });

export const readDirectory = (
  dirPath: string,
): Effect.Effect<ReadonlyArray<string>, PiMillFileError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem
      .readDirectory(dirPath)
      .pipe(
        Effect.mapError(
          (cause) => new PiMillFileError({ operation: "list", path: dirPath, cause }),
        ),
      );
  });
