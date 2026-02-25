import * as Command from "@effect/platform/Command";
import * as FileSystem from "@effect/platform/FileSystem";
import { Data, Effect } from "effect";
import type { DriverProcessConfig, DriverRuntime, DriverSpawnInput } from "@mill/core";
import { decodePiProcessOutput } from "./pi.codec";

export class PiProcessDriverError extends Data.TaggedError("PiProcessDriverError")<{
  message: string;
}> {}

const toMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const normalizePath = (path: string): string => {
  if (path.length <= 1) {
    return path;
  }

  return path.endsWith("/") ? path.slice(0, -1) : path;
};

const joinPath = (base: string, child: string): string =>
  normalizePath(base) === "/" ? `/${child}` : `${normalizePath(base)}/${child}`;

const sessionPathForSpawn = (input: DriverSpawnInput): string =>
  joinPath(joinPath(input.runDirectory, "sessions"), `${input.spawnId}.jsonl`);

const commandForSpawn = (
  config: DriverProcessConfig,
  input: DriverSpawnInput,
  sessionPath: string,
): Command.Command => {
  const command = Command.make(
    config.command,
    ...config.args,
    "--session",
    sessionPath,
    "--model",
    input.model,
    "--system-prompt",
    input.systemPrompt,
    input.prompt,
  ).pipe(Command.stdin("ignore"));

  if (config.env === undefined || Object.keys(config.env).length === 0) {
    return command;
  }

  return Command.env(command, config.env);
};

export const makePiProcessDriver = (config: DriverProcessConfig): DriverRuntime => ({
  name: "pi",
  spawn: (input) =>
    Effect.gen(function* () {
      const sessionPath = sessionPathForSpawn(input);
      const sessionsDirectory = sessionPath.slice(0, sessionPath.lastIndexOf("/"));
      const fileSystem = yield* FileSystem.FileSystem;

      yield* Effect.mapError(
        fileSystem.makeDirectory(sessionsDirectory, { recursive: true }),
        (error) =>
          new PiProcessDriverError({
            message: `Unable to create session directory '${sessionsDirectory}': ${toMessage(error)}`,
          }),
      );

      const command = commandForSpawn(config, input, sessionPath);

      yield* Effect.logDebug("mill.driver-pi:spawn:start", {
        runId: input.runId,
        spawnId: input.spawnId,
        agent: input.agent,
        model: input.model,
        command: config.command,
        sessionPath,
      });

      const stdout = yield* Effect.mapError(
        Command.string(command),
        (error) =>
          new PiProcessDriverError({
            message: toMessage(error),
          }),
      );

      const decoded = yield* Effect.mapError(
        decodePiProcessOutput(stdout, {
          agent: input.agent,
          model: input.model,
          spawnId: input.spawnId,
        }),
        (error) =>
          new PiProcessDriverError({
            message: toMessage(error),
          }),
      );

      const raw = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const result = {
        ...decoded.result,
        sessionRef: sessionPath,
      };

      yield* Effect.logDebug("mill.driver-pi:spawn:complete", {
        runId: input.runId,
        spawnId: input.spawnId,
        rawLines: raw.length,
        sessionRef: result.sessionRef,
      });

      return {
        ...decoded,
        result,
        raw,
      };
    }),
  resolveSession: ({ sessionRef }) =>
    Effect.succeed({
      driver: "pi",
      sessionRef,
      pointer: `pi://session/${encodeURIComponent(sessionRef)}`,
    }),
});
