import { Effect } from "effect";
import type { AgentRuntime, AgentSessionInput, AgentProcessConfig } from "@mill/core";
import { createAcpSession } from "./acp-client.effect";

export const makeAcpProviderRuntime = (
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
            provider: name,
          },
        })),
    })),
});
