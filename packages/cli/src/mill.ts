#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Exit, Layer, Runtime, Stream } from "effect";
import {
  Mill,
  MillLive,
  PathServiceLive,
  EventAppenderLive,
  EntityRegistryLive,
  IdGeneratorLive,
  ProgramHostLive,
} from "@mill/core";
import { ProcessLive, SpawnAgentRuntimeLive } from "@mill/provider-acp";

const usage = `mill — supervised task runtime

Usage:
  mill run <program.ts>     Submit a program task; prints taskId
  mill status <taskId>      Show current task snapshot
  mill watch <taskId>       Stream events for a task
  mill cancel <taskId>      Cancel a task (cascades to children)
  mill ls [--all]           List root tasks; --all for everything
  mill wait <taskId>        Wait for task to reach terminal status

Options:
  --tasks-dir <path>        Tasks directory (default: ~/.mill/tasks)
  --shallow                 Scope watch to task only (no subtree)
  --include <types>         Comma-separated event types to include
  --exclude <types>         Comma-separated event types to exclude
  -h, --help                Show this help message
`;

const parseArgs = (
  args: ReadonlyArray<string>,
): { command: string; positional: string[]; flags: Record<string, string | boolean> } => {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  const command = positional[0] ?? "";
  return { command, positional: positional.slice(1), flags };
};

const makeMillLayer = (tasksDirectory: string) => {
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
      ),
    ),
    Layer.provide(fsLayer),
    Layer.provide(IdGeneratorLive),
  );
};

const mainEffect = (args: ReadonlyArray<string>): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    const { command, positional, flags } = parseArgs(args);

    if (flags.help || command === "") {
      console.log(usage);
      return 0;
    }

    const tasksDirectory =
      typeof flags["tasks-dir"] === "string"
        ? flags["tasks-dir"]
        : `${process.env.HOME ?? "/tmp"}/.mill/tasks`;

    const millLayer = makeMillLayer(tasksDirectory);

    const runMill = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
      Effect.provide(effect, millLayer);

    switch (command) {
      case "run": {
        const programPath = positional[0];
        if (!programPath) {
          console.error("Error: program path required");
          return 1;
        }
        const taskId = yield* runMill(
          Effect.gen(function* () {
            const mill = yield* Mill;
            return yield* mill.submit(programPath);
          }),
        );
        console.log(taskId);
        return 0;
      }

      case "status": {
        const taskId = positional[0];
        if (!taskId) {
          console.error("Error: taskId required");
          return 1;
        }
        const snapshot = yield* runMill(
          Effect.gen(function* () {
            const mill = yield* Mill;
            return yield* mill.status(taskId);
          }),
        );
        console.log(JSON.stringify(snapshot, null, 2));
        return 0;
      }

      case "wait": {
        const taskId = positional[0];
        if (!taskId) {
          console.error("Error: taskId required");
          return 1;
        }
        const snapshot = yield* runMill(
          Effect.gen(function* () {
            const mill = yield* Mill;
            yield* mill.result(taskId);
            return yield* mill.status(taskId);
          }),
        );
        console.log(JSON.stringify(snapshot, null, 2));
        return 0;
      }

      case "watch": {
        const taskId = positional[0];
        if (!taskId) {
          console.error("Error: taskId required");
          return 1;
        }
        yield* runMill(
          Effect.gen(function* () {
            const mill = yield* Mill;
            const events = mill.watch(taskId, { shallow: flags.shallow === true });
            yield* Stream.runForEach(events, (event) =>
              Effect.sync(() => console.log(JSON.stringify(event))),
            );
          }),
        );
        return 0;
      }

      case "cancel": {
        const taskId = positional[0];
        if (!taskId) {
          console.error("Error: taskId required");
          return 1;
        }
        yield* runMill(
          Effect.gen(function* () {
            const mill = yield* Mill;
            return yield* mill.cancel(taskId);
          }),
        );
        return 0;
      }

      case "ls": {
        const ids = yield* runMill(
          Effect.gen(function* () {
            const mill = yield* Mill;
            return yield* mill.list({ all: flags.all === true });
          }),
        );
        for (const id of ids) {
          console.log(id);
        }
        return 0;
      }

      default: {
        console.error(`Unknown command: ${command}`);
        console.log(usage);
        return 1;
      }
    }
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.sync(() => {
        console.error(String(error));
        return 1;
      }),
    ),
  );

const args = process.argv.slice(2);
const main = mainEffect(args);

BunRuntime.runMain(main, {
  teardown: (exit, onExit) => {
    if (Exit.isSuccess(exit)) {
      onExit(exit.value as number);
      return;
    }
    Runtime.defaultTeardown(exit, onExit);
  },
});
