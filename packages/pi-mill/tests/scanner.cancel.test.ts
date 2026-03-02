import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { cancelRunByPidFiles } from "../scanner.ts";

describe("cancelRunByPidFiles", () => {
  it("passes --runs-dir inferred from canonical run artifacts when mill.runsDir is absent", async () => {
    const tempDirectory = await mkdtemp(path.join(tmpdir(), "pi-mill-cancel-run-dir-"));
    const runsDirectory = path.join(tempDirectory, "runs");
    const artifactsDir = path.join(runsDirectory, "run_test");
    const fakeBinDirectory = path.join(tempDirectory, "bin");
    const fakeMillPath = path.join(fakeBinDirectory, "mill");
    const argvLogPath = path.join(tempDirectory, "mill-argv.log");

    try {
      await mkdir(fakeBinDirectory, { recursive: true });
      await mkdir(artifactsDir, { recursive: true });

      const escapedLogPath = argvLogPath.replaceAll('"', '\\"');
      const escapedRunsDir = runsDirectory.replaceAll('"', '\\"');

      await writeFile(
        fakeMillPath,
        [
          "#!/bin/sh",
          `printf "%s\\n" "$@" > "${escapedLogPath}"`,
          'prev=""',
          'for arg in "$@"; do',
          `  if [ "$prev" = "--runs-dir" ] && [ "$arg" = "${escapedRunsDir}" ]; then`,
          "    exit 0",
          "  fi",
          '  prev="$arg"',
          "done",
          "exit 1",
          "",
        ].join("\n"),
        "utf-8",
      );
      await chmod(fakeMillPath, 0o755);

      await writeFile(
        path.join(artifactsDir, "run.json"),
        JSON.stringify(
          {
            id: "run_test",
            status: "running",
            mill: {
              command: fakeMillPath,
              args: [],
            },
            paths: {
              runDir: artifactsDir,
              runFile: path.join(artifactsDir, "run.json"),
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const cancelledCount = cancelRunByPidFiles(artifactsDir);
      expect(cancelledCount).toBe(1);

      const argvLines = (await readFile(argvLogPath, "utf-8"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      expect(argvLines).toContain("cancel");
      expect(argvLines).toContain("run_test");
      expect(argvLines).toContain("--runs-dir");
      expect(argvLines).toContain(runsDirectory);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
