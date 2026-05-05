import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cliPath = join(import.meta.dir, "mill.ts");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mill CLI", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir.length > 0) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("run launches a detached worker and returns promptly", async () => {
    tmpDir = `/tmp/mill-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tasksDir = join(tmpDir, "tasks");
    const programPath = join(tmpDir, "slow-program.ts");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      programPath,
      [
        "export default async function() {",
        "  console.log('worker-started');",
        "  await new Promise((resolve) => setTimeout(resolve, 1200));",
        "  console.log('worker-finished');",
        "  return 'ok';",
        "}",
      ].join("\n"),
    );

    const startedAt = performance.now();
    const run = Bun.spawn(
      [process.execPath, "run", cliPath, "run", programPath, "--tasks-dir", tasksDir, "--quiet"],
      {
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    const elapsedMs = performance.now() - startedAt;

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(elapsedMs).toBeLessThan(1_000);

    const taskId = stdout.trim();
    expect(taskId.startsWith("task_")).toBe(true);
    expect(existsSync(join(tasksDir, taskId, "worker.pid"))).toBe(true);
    expect(existsSync(join(tasksDir, taskId, "logs", "worker.log"))).toBe(true);

    const earlyEvents = readFileSync(join(tasksDir, taskId, "events.ndjson"), "utf-8");
    expect(earlyEvents).toContain('"task:started"');
    expect(earlyEvents).not.toContain('"task:completed"');

    for (let i = 0; i < 20; i++) {
      const events = readFileSync(join(tasksDir, taskId, "events.ndjson"), "utf-8");
      if (events.includes('"task:completed"')) {
        expect(events).toContain("worker-finished");
        return;
      }
      await sleep(150);
    }

    throw new Error("Detached worker did not complete in time");
  });

  test("global boolean flags work before the command", async () => {
    tmpDir = `/tmp/mill-cli-global-flag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tasksDir = join(tmpDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    const run = Bun.spawn(
      [process.execPath, "run", cliPath, "--json", "ls", "--tasks-dir", tasksDir],
      {
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ tasks: [] });
  });

  test("run --json emits stable task metadata", async () => {
    tmpDir = `/tmp/mill-cli-json-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tasksDir = join(tmpDir, "tasks");
    const programPath = join(tmpDir, "program.ts");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(programPath, "export default function() { return 'ok'; }\n");

    const run = Bun.spawn(
      [process.execPath, "run", cliPath, "run", programPath, "--tasks-dir", tasksDir, "--json"],
      {
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const payload = JSON.parse(stdout) as {
      taskId: string;
      program: string;
      status: string;
      eventsPath: string;
      workerLogPath: string;
      watchCommand: string;
    };
    expect(payload.taskId.startsWith("task_")).toBe(true);
    expect(payload.program).toBe(programPath);
    expect(payload.status).toBe("started");
    expect(payload.eventsPath).toBe(join(tasksDir, payload.taskId, "events.ndjson"));
    expect(payload.workerLogPath).toBe(join(tasksDir, payload.taskId, "logs", "worker.log"));
    expect(payload.watchCommand).toBe(`mill watch ${payload.taskId}`);
  });

  test("run --sync --json reports terminal status without detached worker log", async () => {
    tmpDir = `/tmp/mill-cli-sync-json-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tasksDir = join(tmpDir, "tasks");
    const programPath = join(tmpDir, "program.ts");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(programPath, "export default function() { return 'done'; }\n");

    const run = Bun.spawn(
      [
        process.execPath,
        "run",
        cliPath,
        "run",
        programPath,
        "--tasks-dir",
        tasksDir,
        "--sync",
        "--json",
      ],
      {
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const payload = JSON.parse(stdout) as {
      taskId: string;
      program: string;
      status: string;
      eventsPath: string;
      workerLogPath?: string;
      result?: string;
      watchCommand: string;
    };
    expect(payload.taskId.startsWith("task_")).toBe(true);
    expect(payload.program).toBe(programPath);
    expect(payload.status).toBe("completed");
    expect(payload.eventsPath).toBe(join(tasksDir, payload.taskId, "events.ndjson"));
    expect(payload.workerLogPath).toBeUndefined();
    expect(payload.result).toBe("done");
    expect(existsSync(join(tasksDir, payload.taskId, "logs", "worker.log"))).toBe(false);
  });
});
