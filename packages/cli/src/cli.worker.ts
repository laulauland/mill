#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Effect, Exit, Runtime } from "effect";
import { Mill } from "@mill/core";
import { makeMillLayer } from "./cli.platform";

const usage = "Usage: cli.worker.ts <taskId> <program.ts> <tasksDirectory>";

export const workerMainEffect = (args: ReadonlyArray<string>): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    const [taskId, programPath, tasksDirectory] = args;

    if (!taskId || !programPath || !tasksDirectory) {
      console.error(usage);
      return 1;
    }

    const millLayer = makeMillLayer(tasksDirectory);

    yield* Effect.provide(
      Effect.gen(function* () {
        const mill = yield* Mill;
        yield* mill.executePrepared(taskId, programPath);
      }),
      millLayer,
    );

    return 0;
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.sync(() => {
        console.error(String(error));
        return 1;
      }),
    ),
  );

if (import.meta.main) {
  BunRuntime.runMain(workerMainEffect(process.argv.slice(2)), {
    teardown: (exit, onExit) => {
      if (Exit.isSuccess(exit)) {
        onExit(exit.value as number);
        return;
      }
      Runtime.defaultTeardown(exit, onExit);
    },
  });
}
