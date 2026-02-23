import * as Command from "@effect/platform/Command";
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

const commandForSpawn = (config: DriverProcessConfig, input: DriverSpawnInput): Command.Command => {
  const payload = JSON.stringify({
    runId: input.runId,
    spawnId: input.spawnId,
    agent: input.agent,
    systemPrompt: input.systemPrompt,
    prompt: input.prompt,
    model: input.model,
  });

  return Command.env(Command.make(config.command, ...config.args, payload), config.env ?? {});
};

export const makePiProcessDriver = (config: DriverProcessConfig): DriverRuntime => ({
  name: "pi",
  spawn: (input) =>
    Effect.gen(function* () {
      const command = commandForSpawn(config, input);
      const stdout = yield* Effect.mapError(
        Command.string(command),
        (error) =>
          new PiProcessDriverError({
            message: toMessage(error),
          }),
      );

      return yield* Effect.mapError(
        decodePiProcessOutput(stdout),
        (error) =>
          new PiProcessDriverError({
            message: toMessage(error),
          }),
      );
    }),
});
