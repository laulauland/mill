import type { DriverProcessConfig } from "@mill/core";

export const createPiDriverConfig = (): DriverProcessConfig => ({
  command: "pi",
  args: ["-p"],
  env: {},
});
