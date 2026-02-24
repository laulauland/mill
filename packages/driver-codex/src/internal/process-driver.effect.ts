import * as Command from "@effect/platform/Command";
import * as FileSystem from "@effect/platform/FileSystem";
import { Data, Effect } from "effect";
import type { DriverProcessConfig, DriverRuntime, DriverSpawnInput } from "@mill/core";
import { decodeCodexProcessOutput } from "./codex.codec";

export class CodexProcessDriverError extends Data.TaggedError("CodexProcessDriverError")<{
  message: string;
}> {}

const toMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const normalizeCodexModel = (model: string): string => {
  const parts = model.split("/");
  return parts[parts.length - 1] ?? model;
};

const instructionFilePath = (input: DriverSpawnInput): string =>
  `/tmp/mill-codex-system-${input.runId}-${input.spawnId}.md`;

const commandForSpawn = (
  config: DriverProcessConfig,
  input: DriverSpawnInput,
  systemPromptPath: string,
): Command.Command => {
  const command = Command.make(
    config.command,
    ...config.args,
    "--model",
    normalizeCodexModel(input.model),
    "--config",
    `model_instructions_file=\"${systemPromptPath}\"`,
    input.prompt,
  ).pipe(Command.stdin("ignore"));

  if (config.env === undefined || Object.keys(config.env).length === 0) {
    return command;
  }

  return Command.env(command, config.env);
};

export const makeCodexProcessDriver = (config: DriverProcessConfig): DriverRuntime => ({
  name: "codex",
  spawn: (input) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const systemPromptPath = instructionFilePath(input);

      yield* Effect.mapError(
        fileSystem.writeFileString(systemPromptPath, input.systemPrompt),
        (error) =>
          new CodexProcessDriverError({
            message: `Unable to write codex instruction file: ${toMessage(error)}`,
          }),
      );

      const command = commandForSpawn(config, input, systemPromptPath);

      const spawnEffect = Effect.gen(function* () {
        const stdout = yield* Effect.mapError(
          Command.string(command),
          (error) =>
            new CodexProcessDriverError({
              message: toMessage(error),
            }),
        );

        const decoded = yield* Effect.mapError(
          decodeCodexProcessOutput(stdout, {
            agent: input.agent,
            model: input.model,
            spawnId: input.spawnId,
          }),
          (error) =>
            new CodexProcessDriverError({
              message: toMessage(error),
            }),
        );

        const raw = stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);

        return {
          ...decoded,
          raw,
        };
      });

      return yield* Effect.ensuring(
        spawnEffect,
        Effect.ignore(fileSystem.remove(systemPromptPath)),
      );
    }),
  resolveSession: ({ sessionRef }) =>
    Effect.succeed({
      driver: "codex",
      sessionRef,
      pointer: `codex://session/${encodeURIComponent(sessionRef)}`,
    }),
});
