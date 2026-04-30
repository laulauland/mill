import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";

const joinPath = (base: string, child: string): string =>
  base.endsWith("/") ? `${base}${child}` : `${base}/${child}`;

export const readPiSettingsFileEffect = (
  homeDirectory: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const settingsPath = joinPath(homeDirectory, ".pi/agent/settings.json");
    const exists = yield* fileSystem.exists(settingsPath);
    if (!exists) {
      return undefined;
    }
    return yield* fileSystem.readFileString(settingsPath, "utf8");
  });

export const readPiSettingsFile = (homeDirectory: string): Effect.Effect<string | undefined> =>
  Effect.provide(readPiSettingsFileEffect(homeDirectory), BunServices.layer);
