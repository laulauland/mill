import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const vendorDir = path.join(packageDir, ".vendor");
const bundledCliPath = path.join(vendorDir, "mill.mjs");

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  });

  if (result.stdout && result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr && result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${String(result.status)}`);
  }
};

run(process.execPath, [path.join(__dirname, "sync-skills.mjs")], packageDir);

fs.rmSync(vendorDir, { recursive: true, force: true });
fs.mkdirSync(vendorDir, { recursive: true });

run(
  "bun",
  [
    "build",
    path.join(repoRoot, "packages", "cli", "src", "bin", "mill.ts"),
    "--bundle",
    "--target=node",
    "--format=esm",
    "--outfile",
    bundledCliPath,
  ],
  repoRoot,
);

console.log(`Bundled mill CLI into ${bundledCliPath}`);
