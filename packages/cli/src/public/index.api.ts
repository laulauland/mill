import { createDiscoveryPayload } from "@mill/core";

export const runCli = async (argv: ReadonlyArray<string>): Promise<number> => {
  const showHelp = argv.length === 0 || argv.includes("--help");

  if (showHelp) {
    const payload = await createDiscoveryPayload();
    const output = argv.includes("--json")
      ? JSON.stringify(payload)
      : [
          "mill — Effect-first orchestration runtime",
          "",
          "Run `mill --help --json` for machine-readable discovery.",
        ].join("\n");
    console.log(output);
    return 0;
  }

  console.log("v0 scaffold: only help/discovery is wired in this foundation stage.");
  return 0;
};
