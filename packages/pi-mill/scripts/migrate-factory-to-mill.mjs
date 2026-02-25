#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);

const getArgValue = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
};

const hasArg = (name) => args.includes(name);

const sessionsDir =
  getArgValue("--sessions-dir") ?? path.join(os.homedir(), ".pi", "agent", "sessions");
const dryRun = hasArg("--dry-run");
const mode = getArgValue("--mode") ?? "copy"; // copy | move
const overwrite = hasArg("--overwrite");
const cleanup = hasArg("--cleanup");

if (hasArg("--help") || hasArg("-h")) {
  console.log(`migrate-factory-to-mill

Migrates pi-mill run artifacts from:
  <session>/.factory/<runId>
to:
  <session>/.mill/<runId>

Usage:
  node ./scripts/migrate-factory-to-mill.mjs [options]

Options:
  --sessions-dir <path>  Sessions root (default: ~/.pi/agent/sessions)
  --mode <copy|move>     copy (default) or move
  --overwrite            Overwrite files if destination exists
  --cleanup              Remove empty .factory directories after migration
  --dry-run              Print actions without changing files
  -h, --help             Show help
`);
  process.exit(0);
}

if (mode !== "copy" && mode !== "move") {
  console.error(`Invalid --mode '${mode}'. Use 'copy' or 'move'.`);
  process.exit(1);
}

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

const isDirectory = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const ensureDir = (dir) => {
  if (dryRun) return;
  fs.mkdirSync(dir, { recursive: true });
};

const copyOrMoveRecursive = (src, dst, options) => {
  const { overwriteFiles, moveFiles } = options;
  const stat = fs.statSync(src);

  if (stat.isDirectory()) {
    ensureDir(dst);
    for (const entry of fs.readdirSync(src)) {
      copyOrMoveRecursive(path.join(src, entry), path.join(dst, entry), options);
    }
    if (moveFiles) {
      const remaining = fs.readdirSync(src);
      if (remaining.length === 0 && !dryRun) {
        fs.rmdirSync(src);
      }
    }
    return;
  }

  ensureDir(path.dirname(dst));

  if (exists(dst) && !overwriteFiles) {
    return;
  }

  if (moveFiles) {
    if (dryRun) return;

    try {
      fs.renameSync(src, dst);
    } catch {
      fs.copyFileSync(src, dst);
      fs.rmSync(src, { force: true });
    }
    return;
  }

  if (!dryRun) {
    fs.copyFileSync(src, dst);
  }
};

const stat = {
  sessionsScanned: 0,
  sessionsTouched: 0,
  runDirsMigrated: 0,
  runDirsMerged: 0,
  filesOverwritten: 0,
  skippedNoFactory: 0,
};

if (!exists(sessionsDir) || !isDirectory(sessionsDir)) {
  console.error(`Sessions directory not found: ${sessionsDir}`);
  process.exit(1);
}

const sessionEntries = fs
  .readdirSync(sessionsDir)
  .filter((entry) => isDirectory(path.join(sessionsDir, entry)));

for (const sessionName of sessionEntries) {
  stat.sessionsScanned += 1;

  const sessionPath = path.join(sessionsDir, sessionName);
  const sourceRoot = path.join(sessionPath, ".factory");
  const targetRoot = path.join(sessionPath, ".mill");

  if (!exists(sourceRoot) || !isDirectory(sourceRoot)) {
    stat.skippedNoFactory += 1;
    continue;
  }

  const runEntries = fs
    .readdirSync(sourceRoot)
    .filter((entry) => isDirectory(path.join(sourceRoot, entry)));

  if (runEntries.length === 0) {
    continue;
  }

  stat.sessionsTouched += 1;
  ensureDir(targetRoot);

  for (const runId of runEntries) {
    const srcRunDir = path.join(sourceRoot, runId);
    const dstRunDir = path.join(targetRoot, runId);

    const destinationExists = exists(dstRunDir);

    if (destinationExists) {
      stat.runDirsMerged += 1;
    } else {
      stat.runDirsMigrated += 1;
    }

    if (dryRun) {
      console.log(
        `[dry-run] ${mode} ${srcRunDir} -> ${dstRunDir}${destinationExists ? " (merge)" : ""}`,
      );
    }

    if (overwrite && destinationExists) {
      const walk = (p) => {
        for (const entry of fs.readdirSync(p)) {
          const full = path.join(p, entry);
          const s = fs.statSync(full);
          if (s.isDirectory()) walk(full);
          else {
            const rel = path.relative(srcRunDir, full);
            const dst = path.join(dstRunDir, rel);
            if (exists(dst)) stat.filesOverwritten += 1;
          }
        }
      };
      walk(srcRunDir);
    }

    copyOrMoveRecursive(srcRunDir, dstRunDir, {
      overwriteFiles: overwrite,
      moveFiles: mode === "move",
    });
  }

  if (cleanup && mode === "move") {
    try {
      const leftovers = fs.readdirSync(sourceRoot);
      if (leftovers.length === 0) {
        if (dryRun) {
          console.log(`[dry-run] remove ${sourceRoot}`);
        } else {
          fs.rmdirSync(sourceRoot);
        }
      }
    } catch {
      // ignore
    }
  }
}

console.log("\nMigration summary:");
console.log(`- sessions scanned: ${stat.sessionsScanned}`);
console.log(`- sessions touched: ${stat.sessionsTouched}`);
console.log(`- run dirs migrated (new): ${stat.runDirsMigrated}`);
console.log(`- run dirs merged (already existed): ${stat.runDirsMerged}`);
if (overwrite) {
  console.log(`- files overwritten: ${stat.filesOverwritten}`);
}
console.log(`- sessions without .factory: ${stat.skippedNoFactory}`);
console.log(`- mode: ${mode}${dryRun ? " (dry-run)" : ""}`);
