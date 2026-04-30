import { Effect } from "effect";
import type {
  DriverProcessConfig,
  DriverRuntime,
  DriverSpawnInput,
  DriverTaskSessionInput,
} from "@mill/core";
import { createAcpTaskSession, runAcpSession } from "./acp-client.effect";

export const makeAcpDriver = (
  name: string,
  processConfig?: DriverProcessConfig,
): DriverRuntime => ({
  name,
  spawn: (input: DriverSpawnInput) =>
    Effect.map(Effect.scoped(runAcpSession(name, processConfig, input)), (output) => ({
      ...output,
      result: {
        ...output.result,
        driver: name,
      },
    })),
  createTaskSession: (input: DriverTaskSessionInput) =>
    Effect.map(createAcpTaskSession(name, processConfig, input), (session) => ({
      ...session,
      startTurn: (turn) =>
        Effect.map(session.startTurn(turn), (output) => ({
          ...output,
          result: {
            ...output.result,
            driver: name,
          },
        })),
    })),
  resolveSession: ({ sessionRef }) =>
    Effect.succeed({
      driver: name,
      sessionRef,
      pointer: `acp://${name}/session/${encodeURIComponent(sessionRef)}`,
    }),
});
