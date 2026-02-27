import { Effect } from "effect";
import type { DriverProcessConfig, DriverRuntime, DriverSpawnInput } from "@mill/core";
import { runAcpSession } from "./acp-client.effect";

export const makeAcpDriver = (name: string, processConfig: DriverProcessConfig): DriverRuntime => ({
  name,
  spawn: (input: DriverSpawnInput) => Effect.scoped(runAcpSession(processConfig, input)),
  resolveSession: ({ sessionRef }) =>
    Effect.succeed({
      driver: name,
      sessionRef,
      pointer: `acp://${name}/session/${encodeURIComponent(sessionRef)}`,
    }),
});
