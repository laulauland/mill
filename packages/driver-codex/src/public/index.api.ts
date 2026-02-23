import type { DriverProcessConfig } from "@mill/core";

export const createCodexDriverConfig = (): DriverProcessConfig => ({
  command: "codex",
  args: [],
  env: {},
});
