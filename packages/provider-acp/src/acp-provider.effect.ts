import { Effect } from "effect";
import type { AgentRuntime, AgentSessionInput } from "@mill/core";
import { createAcpSession } from "./acp-client.effect";
import type { AgentProcessConfig } from "./process-config";

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
