import { Effect } from "effect";
import type { AgentSessionInput, DriverProcessConfig, DriverRuntime } from "@mill/core";
import { createAcpSession } from "./acp-client.effect";

export const makeAcpDriver = (
  name: string,
  processConfig?: DriverProcessConfig,
): DriverRuntime => ({
  name,
  createSession: (input: AgentSessionInput) =>
    Effect.map(createAcpSession(name, processConfig, input), (session) => ({
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
