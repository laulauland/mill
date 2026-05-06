import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Layer } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import {
  EventAppenderLive,
  EntityRegistryLive,
  IdGeneratorLive,
  MillLive,
  PathServiceLive,
  ProgramHostLive,
  ShellRuntimeLive,
} from "@mill/core";
import { ProcessLive, SpawnAgentRuntimeLive } from "@mill/provider-acp";

export const launchDetachedWorker = ({
  taskId,
  programPath,
  tasksDirectory,
}: {
  readonly taskId: string;
  readonly programPath: string;
  readonly tasksDirectory: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const taskDirectory = path.join(tasksDirectory, taskId);
      const logDirectory = path.join(taskDirectory, "logs");
      const workerLogPath = path.join(logDirectory, "worker.log");

      yield* fs.makeDirectory(logDirectory, { recursive: true });

      yield* fs.writeFileString(workerLogPath, "", { flag: "a" });

      const cliScriptPath = process.argv[1];
      const workerCommand = [
        'if [ -n "${MILL_CLI_SCRIPT:-}" ] && [ -f "$MILL_CLI_SCRIPT" ]; then',
        '  exec "$MILL_EXEC_PATH" run "$MILL_CLI_SCRIPT" __worker "$TASK_ID" "$PROGRAM_PATH" "$TASKS_DIR" >> "$WORKER_LOG" 2>&1',
        "else",
        '  exec "$MILL_EXEC_PATH" __worker "$TASK_ID" "$PROGRAM_PATH" "$TASKS_DIR" >> "$WORKER_LOG" 2>&1',
        "fi",
      ].join("\n");

      const worker = yield* ChildProcess.make("sh", ["-c", workerCommand], {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        extendEnv: true,
        env: {
          MILL_EXEC_PATH: process.execPath,
          MILL_CLI_SCRIPT: cliScriptPath,
          TASK_ID: taskId,
          PROGRAM_PATH: programPath,
          TASKS_DIR: tasksDirectory,
          WORKER_LOG: workerLogPath,
        },
      });
      yield* worker.unref;
      yield* fs.writeFileString(path.join(taskDirectory, "worker.pid"), `${worker.pid}\n`);

      return worker.pid;
    }),
  );

export const stopDetachedWorker = (tasksDirectory: string, taskId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pidFile = path.join(tasksDirectory, taskId, "worker.pid");
    const pidText = yield* fs
      .readFileString(pidFile, "utf-8")
      .pipe(Effect.catch(() => Effect.succeed("")));
    const pid = Number(pidText.trim());

    if (Number.isInteger(pid) && pid > 0) {
      const kill = yield* ChildProcess.make("kill", ["-TERM", String(pid)], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      yield* kill.exitCode.pipe(Effect.catch(() => Effect.void));
    }
  });

export const makeMillLayer = (tasksDirectory: string) => {
  const fsLayer = EventAppenderLive.pipe(
    Layer.provide(PathServiceLive(tasksDirectory)),
    Layer.provide(BunServices.layer),
  );
  const registryLayer = EntityRegistryLive.pipe(
    Layer.provide(fsLayer),
    Layer.provide(IdGeneratorLive),
  );
  return MillLive.pipe(
    Layer.provide(registryLayer),
    Layer.provide(
      ProgramHostLive.pipe(
        Layer.provide(registryLayer),
        Layer.provide(fsLayer),
        Layer.provide(
          SpawnAgentRuntimeLive.pipe(Layer.provide(BunServices.layer), Layer.provide(ProcessLive)),
        ),
        Layer.provide(ShellRuntimeLive.pipe(Layer.provide(BunServices.layer))),
      ),
    ),
    Layer.provide(fsLayer),
    Layer.provide(IdGeneratorLive),
  );
};
