import * as Command from "@effect/platform/Command";
import { Data, Effect } from "effect";
import type { DriverProcessConfig, DriverRuntime, DriverSpawnInput } from "@mill/core";
import { decodeClaudeProcessOutput } from "./claude.codec";

export class ClaudeProcessDriverError extends Data.TaggedError("ClaudeProcessDriverError")<{
  message: string;
}> {}

const toMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const normalizeClaudeModel = (model: string): string => {
  const parts = model.split("/");
  return parts[parts.length - 1] ?? model;
};

const commandForSpawn = (
  config: DriverProcessConfig,
  input: DriverSpawnInput,
): Command.Command => {
  const command = Command.make(
    config.command,
    ...config.args,
    "--model",
    normalizeClaudeModel(input.model),
    "--system-prompt",
    input.systemPrompt,
    input.prompt,
  ).pipe(Command.stdin("ignore"));

  if (config.env === undefined || Object.keys(config.env).length === 0) {
    return command;
  }

  return Command.env(command, config.env);
};

export const makeClaudeProcessDriver = (config: DriverProcessConfig): DriverRuntime => ({
  name: "claude",
  spawn: (input) =>
    Effect.gen(function* () {
      const command = commandForSpawn(config, input);
      const stdout = yield* Effect.mapError(
        Command.string(command),
        (error) =>
          new ClaudeProcessDriverError({
            message: toMessage(error),
          }),
      );

      const decoded = yield* Effect.mapError(
        decodeClaudeProcessOutput(stdout, {
          agent: input.agent,
          model: input.model,
          spawnId: input.spawnId,
        }),
        (error) =>
          new ClaudeProcessDriverError({
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
    }),
  resolveSession: ({ sessionRef }) =>
    Effect.succeed({
      driver: "claude",
      sessionRef,
      pointer: `claude://session/${encodeURIComponent(sessionRef)}`,
    }),
});
