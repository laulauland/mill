import { Effect } from "effect";
import type { DriverProcessConfig, DriverRuntime, DriverSpawnInput } from "@mill/core";
import { runAcpSession } from "./acp-client.effect";

export const makeAcpDriver = (name: string, processConfig: DriverProcessConfig): DriverRuntime => ({
  name,
  spawn: (input: DriverSpawnInput) =>
    Effect.map(Effect.scoped(runAcpSession(processConfig, input)), (output) => ({
      ...output,
      result: {
        ...output.result,
        driver: name,
      },
    })),
  resolveSession: ({ sessionRef }) =>
    Effect.succeed({
      driver: name,
      sessionRef,
      pointer: `acp://${name}/session/${encodeURIComponent(sessionRef)}`,
    }),
});
