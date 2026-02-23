import type { DriverProcessConfig } from "@mill/core";

export const createClaudeDriverConfig = (): DriverProcessConfig => ({
  command: "claude",
  args: [],
  env: {},
});
