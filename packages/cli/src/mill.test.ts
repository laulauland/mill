import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cliPath = join(import.meta.dir, "mill.ts");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const writeEvents = (tasksDir: string, taskId: string, events: ReadonlyArray<unknown>) => {
  const taskDir = join(tasksDir, taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    taskDir + "/events.ndjson",
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
};

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

  test("ls filters by status", async () => {
    tmpDir = `/tmp/mill-cli-ls-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tasksDir = join(tmpDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeEvents(tasksDir, "task_started", [
      {
        taskId: "task_started",
        sequence: 1,
        timestamp: "2026-05-04T00:00:00.000Z",
        type: "task:created",
        payload: { kind: "program", input: "started.ts" },
      },
      {
        taskId: "task_started",
        sequence: 2,
        timestamp: "2026-05-04T00:00:01.000Z",
        type: "task:started",
        payload: {},
      },
    ]);
    writeEvents(tasksDir, "task_completed", [
      {
        taskId: "task_completed",
        sequence: 1,
        timestamp: "2026-05-04T00:00:02.000Z",
        type: "task:created",
        payload: { kind: "program", input: "completed.ts" },
      },
      {
        taskId: "task_completed",
        sequence: 2,
        timestamp: "2026-05-04T00:00:03.000Z",
        type: "task:started",
        payload: {},
      },
      {
        taskId: "task_completed",
        sequence: 3,
        timestamp: "2026-05-04T00:00:04.000Z",
        type: "task:completed",
        payload: { result: "ok" },
      },
    ]);

    const run = Bun.spawn(
      [
        process.execPath,
        "run",
        cliPath,
        "ls",
        "--tasks-dir",
        tasksDir,
        "--status",
        "started",
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
    expect(JSON.parse(stdout)).toEqual({
      tasks: [
        expect.objectContaining({
          taskId: "task_started",
          status: "started",
        }),
      ],
    });
  });

  test("ls rejects invalid status", async () => {
    tmpDir = `/tmp/mill-cli-ls-invalid-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tasksDir = join(tmpDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    const run = Bun.spawn(
      [process.execPath, "run", cliPath, "ls", "--tasks-dir", tasksDir, "--status", "running"],
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

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(
      'Invalid status "running". Allowed: created, started, completed, failed, cancelled',
    );
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

  test("watch --json replays append-only NDJSON and exits at terminal status", async () => {
    tmpDir = `/tmp/mill-cli-watch-json-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tasksDir = join(tmpDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    const events = [
      {
        taskId: "task_watch_json",
        sequence: 1,
        timestamp: "2026-05-04T00:00:00.000Z",
        type: "task:created",
        payload: { kind: "program", input: "program.ts" },
      },
      {
        taskId: "task_watch_json",
        sequence: 2,
        timestamp: "2026-05-04T00:00:01.000Z",
        type: "task:started",
        payload: {},
      },
      {
        taskId: "task_watch_json",
        sequence: 3,
        timestamp: "2026-05-04T00:00:02.000Z",
        type: "task:completed",
        payload: { result: "ok" },
      },
    ];
    writeEvents(tasksDir, "task_watch_json", events);

    const run = Bun.spawn(
      [
        process.execPath,
        "run",
        cliPath,
        "watch",
        "task_watch_json",
        "--tasks-dir",
        tasksDir,
        "--json",
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(
      stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(events);
  });

  test("watch --json replays child events recorded after the root terminal event", async () => {
    tmpDir = `/tmp/mill-cli-watch-json-late-child-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tasksDir = join(tmpDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    const events = [
      {
        taskId: "task_watch_late_child",
        sequence: 1,
        timestamp: "2026-05-04T00:00:00.000Z",
        type: "task:created",
        payload: { kind: "program", input: "program.ts" },
      },
      {
        taskId: "task_watch_late_child",
        sequence: 2,
        timestamp: "2026-05-04T00:00:01.000Z",
        type: "task:started",
        payload: {},
      },
      {
        taskId: "task_watch_late_child",
        sequence: 3,
        timestamp: "2026-05-04T00:00:02.000Z",
        type: "task:child_spawned",
        payload: { childId: "task_watch_late_child:child:1", kind: "agent" },
      },
      {
        taskId: "task_watch_late_child:child:1",
        sequence: 4,
        timestamp: "2026-05-04T00:00:03.000Z",
        type: "task:created",
        payload: { kind: "agent", parentId: "task_watch_late_child" },
      },
      {
        taskId: "task_watch_late_child",
        sequence: 5,
        timestamp: "2026-05-04T00:00:04.000Z",
        type: "task:completed",
        payload: { result: "root ok" },
      },
      {
        taskId: "task_watch_late_child:child:1",
        sequence: 6,
        timestamp: "2026-05-04T00:00:05.000Z",
        type: "task:message_chunk",
        payload: { text: "late child output" },
      },
      {
        taskId: "task_watch_late_child:child:1",
        sequence: 7,
        timestamp: "2026-05-04T00:00:06.000Z",
        type: "task:completed",
        payload: { result: "child ok" },
      },
    ];
    writeEvents(tasksDir, "task_watch_late_child", events);

    const run = Bun.spawn(
      [
        process.execPath,
        "run",
        cliPath,
        "watch",
        "task_watch_late_child",
        "--tasks-dir",
        tasksDir,
        "--json",
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(
      stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(events);
  });

  test("watch defaults to sparse milestones when stdout is not a TTY", async () => {
    tmpDir = `/tmp/mill-cli-watch-milestone-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tasksDir = join(tmpDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeEvents(tasksDir, "task_watch_milestone", [
      {
        taskId: "task_watch_milestone",
        sequence: 1,
        timestamp: "2026-05-04T00:00:00.000Z",
        type: "task:created",
        payload: { kind: "program", input: "program.ts" },
      },
      {
        taskId: "task_watch_milestone",
        sequence: 2,
        timestamp: "2026-05-04T00:00:01.000Z",
        type: "task:started",
        payload: {},
      },
      {
        taskId: "task_watch_milestone",
        sequence: 3,
        timestamp: "2026-05-04T00:00:02.000Z",
        type: "task:message_chunk",
        payload: { text: "this raw event should not be printed" },
      },
      {
        taskId: "task_watch_milestone",
        sequence: 4,
        timestamp: "2026-05-04T00:00:03.000Z",
        type: "task:completed",
        payload: { result: "ok" },
      },
    ]);

    const run = Bun.spawn(
      [process.execPath, "run", cliPath, "watch", "task_watch_milestone", "--tasks-dir", tasksDir],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("✓ completed");
    expect(stdout).toContain("2.0s total");
    expect(stdout).not.toContain("this raw event should not be printed");
    expect(stdout).not.toContain('"task:message_chunk"');
  });
});
