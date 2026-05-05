import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Effect, Layer } from "effect";
import * as BunServices from "@effect/platform-bun/BunServices";
import { ProgramHost, ProgramHostLive } from "./ProgramHost";
import { EventAppender, EventAppenderLive } from "./EventAppender";
import { PathService, PathServiceLive } from "./PathService";
import { EntityRegistry, EntityRegistryLive } from "./EntityRegistry";
import { IdGeneratorLive } from "./IdGenerator";
import { AgentRuntimeStub } from "./AgentRuntime";
import { ShellRuntimeLive } from "./ShellRuntime";

const makeTestLayer = (dir: string) => {
  const appenderLayer = EventAppenderLive.pipe(
    Layer.provide(PathServiceLive(dir)),
    Layer.provide(BunServices.layer),
  );
  const registryLayer = EntityRegistryLive.pipe(
    Layer.provide(appenderLayer),
    Layer.provide(IdGeneratorLive),
  );
  const hostLayer = ProgramHostLive.pipe(
    Layer.provide(registryLayer),
    Layer.provide(appenderLayer),
    Layer.provide(AgentRuntimeStub),
    Layer.provide(ShellRuntimeLive.pipe(Layer.provide(BunServices.layer))),
  );
  return Layer.mergeAll(hostLayer, registryLayer, appenderLayer);
};

describe("ProgramHost", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = `/tmp/mill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    try {
      require("fs").rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  const run = <E, A>(
    effect: Effect.Effect<A, E, ProgramHost | EntityRegistry | EventAppender | PathService>,
  ) => {
    const layer = makeTestLayer(tmpDir);
    const program = Effect.provide(effect, layer);
    return Effect.runPromise(program);
  };

  test("runProgram imports and executes a module", async () => {
    const fs = require("fs");
    const programPath = `${tmpDir}/test-program.ts`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(programPath, `export default async function() { return { result: 42 }; };`);

    const result = await run(
      Effect.gen(function* () {
        const registry = yield* EntityRegistry;
        const appender = yield* EventAppender;
        const root = yield* registry.getOrCreate("task-test-1", "task-test-1");
        yield* root.send({ _tag: "CreateTask", kind: "program", input: programPath });
        const started = yield* appender.append("task-test-1", {
          taskId: "task-test-1",
          sequence: 0,
          timestamp: new Date().toISOString(),
          type: "task:started",
          payload: {},
        });
        yield* root.applyEvent(started);

        const host = yield* ProgramHost;
        return yield* host.runProgram(programPath, "task-test-1");
      }),
    );

    expect(result).toBeDefined();
  });

  test("complete waits behind ignored send calls", async () => {
    const fs = require("fs");
    const programPath = `${tmpDir}/open-loop-program.ts`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      programPath,
      `import { claude, task } from "${import.meta.dir}/../program.api.ts";

export default async function() {
  const child = task({ agent: claude("stub") });
  child.send("first");
  child.send("second");
  child.complete();
  return await child.done;
}
`,
    );

    const result = await run(
      Effect.gen(function* () {
        const registry = yield* EntityRegistry;
        const appender = yield* EventAppender;
        const root = yield* registry.getOrCreate("task-test-2", "task-test-2");
        yield* root.send({ _tag: "CreateTask", kind: "program", input: programPath });
        const started = yield* appender.append("task-test-2", {
          taskId: "task-test-2",
          sequence: 0,
          timestamp: new Date().toISOString(),
          type: "task:started",
          payload: {},
        });
        yield* root.applyEvent(started);

        const host = yield* ProgramHost;
        const output = yield* host.runProgram(programPath, "task-test-2");
        const events = yield* appender.readEvents("task-test-2");
        return { output, events };
      }),
    );

    expect(result.output).toEqual({ kind: "agent", text: "claude:stub second" });
    expect(
      result.events
        .filter((event) => event.type === "task:turn_completed")
        .map((event) => event.payload.sequence),
    ).toEqual([1, 2]);
  });

  test("runs shell children with stdout and stderr event projection", async () => {
    const fs = require("fs");
    const programPath = `${tmpDir}/shell-program.ts`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      programPath,
      `import { shell } from "${import.meta.dir}/../program.api.ts";

export default async function() {
  return await shell({
    command: "bun",
    args: ["-e", "process.stdout.write('out'); process.stderr.write('err');"],
  }).run();
}
`,
    );

    const result = await run(
      Effect.gen(function* () {
        const registry = yield* EntityRegistry;
        const appender = yield* EventAppender;
        const root = yield* registry.getOrCreate("task-shell-1", "task-shell-1");
        yield* root.send({ _tag: "CreateTask", kind: "program", input: programPath });
        const started = yield* appender.append("task-shell-1", {
          taskId: "task-shell-1",
          sequence: 0,
          timestamp: new Date().toISOString(),
          type: "task:started",
          payload: {},
        });
        yield* root.applyEvent(started);

        const host = yield* ProgramHost;
        const output = yield* host.runProgram(programPath, "task-shell-1");
        const events = yield* appender.readEvents("task-shell-1");
        const childId = events.find((event) => event.type === "task:child_spawned")?.payload
          .childId;
        const child = childId === undefined ? undefined : yield* registry.lookup(childId);
        const snapshot = child === undefined ? undefined : yield* child.snapshot;
        return { output, events, snapshot };
      }),
    );

    expect(result.output).toEqual({ kind: "shell", stdout: "out", stderr: "err", exitCode: 0 });
    expect(result.snapshot?.text).toBe("out");
    expect(result.snapshot?.thought).toBe("err");
    expect(result.snapshot?.output).toEqual({
      kind: "shell",
      stdout: "out",
      stderr: "err",
      exitCode: 0,
    });
    expect(
      result.events.some(
        (event) => event.type === "task:child_spawned" && event.payload.kind === "shell",
      ),
    ).toBe(true);
  });

  test("shell non-zero exits complete by default", async () => {
    const fs = require("fs");
    const programPath = `${tmpDir}/shell-nonzero-program.ts`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      programPath,
      `import { shell } from "${import.meta.dir}/../program.api.ts";

export default async function() {
  return await shell({ command: "bun", args: ["-e", "process.exit(7);"] }).run();
}
`,
    );

    const output = await run(
      Effect.gen(function* () {
        const registry = yield* EntityRegistry;
        const appender = yield* EventAppender;
        const root = yield* registry.getOrCreate("task-shell-2", "task-shell-2");
        yield* root.send({ _tag: "CreateTask", kind: "program", input: programPath });
        const started = yield* appender.append("task-shell-2", {
          taskId: "task-shell-2",
          sequence: 0,
          timestamp: new Date().toISOString(),
          type: "task:started",
          payload: {},
        });
        yield* root.applyEvent(started);

        const host = yield* ProgramHost;
        return yield* host.runProgram(programPath, "task-shell-2");
      }),
    );

    expect(output).toEqual({ kind: "shell", stdout: "", stderr: "", exitCode: 7 });
  });

  test("shell failOnNonZeroExit fails the child task", async () => {
    const fs = require("fs");
    const programPath = `${tmpDir}/shell-throw-program.ts`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      programPath,
      `import { shell } from "${import.meta.dir}/../program.api.ts";

export default async function() {
  const child = shell({ command: "bun", args: ["-e", "process.stderr.write('bad'); process.exit(9);"], failOnNonZeroExit: true });
  try {
    await child.done;
  } catch {}
  return await child.result();
}
`,
    );

    const result = await run(
      Effect.gen(function* () {
        const registry = yield* EntityRegistry;
        const appender = yield* EventAppender;
        const root = yield* registry.getOrCreate("task-shell-3", "task-shell-3");
        yield* root.send({ _tag: "CreateTask", kind: "program", input: programPath });
        const started = yield* appender.append("task-shell-3", {
          taskId: "task-shell-3",
          sequence: 0,
          timestamp: new Date().toISOString(),
          type: "task:started",
          payload: {},
        });
        yield* root.applyEvent(started);

        const host = yield* ProgramHost;
        const output = yield* host.runProgram(programPath, "task-shell-3");
        const events = yield* appender.readEvents("task-shell-3");
        return { output, events };
      }),
    );

    expect(result.output.status).toBe("failed");
    expect(result.events.some((event) => event.type === "task:failed")).toBe(true);
    expect(result.events.some((event) => event.type === "task:thought_chunk")).toBe(true);
  });
});
