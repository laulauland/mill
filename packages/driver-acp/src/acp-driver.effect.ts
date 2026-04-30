import { Effect } from "effect";
import type { AgentRuntime, AgentSessionInput, AgentProcessConfig } from "@mill/core";
import { createAcpSession } from "./acp-client.effect";

export const makeAcpAgentRuntime = (
  name: string,
  processConfig?: AgentProcessConfig,
): AgentRuntime => ({
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
      provider: name,
      sessionRef,
      pointer: `acp://${name}/session/${encodeURIComponent(sessionRef)}`,
    }),
});
