import { describe, expect, it, spyOn } from "bun:test";
import { runCli } from "./index.api";

describe("runCli", () => {
  it("prints discovery help in json mode", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["--help", "--json"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });
});
