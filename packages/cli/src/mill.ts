#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Exit, Runtime, Stream } from "effect";
import { Mill, TaskStatusValues, type TaskEvent, type TaskStatus } from "@mill/core";
import { launchDetachedWorker, makeMillLayer, stopDetachedWorker } from "./cli.platform";
import { formatRunStarted, formatStatus, formatTaskSummaryTable } from "./cli.format";
import { print, printError, printJson, printNdjson } from "./cli.output";
import { runLiveWatch, runMilestoneWatch } from "./watch-live";
import { workerMainEffect } from "./cli.worker";

const usage = `mill — supervised task runtime

Usage:
  mill run <program.ts> [--json] [--quiet]
                            Submit a program task
  mill run <program.ts> --sync [--json] [--quiet]
                            Run in-process until terminal
  mill run <program.ts> --foreground [--json]
                            Run in-process with live event output
  mill run <program.ts> --watch [--json] [--raw] [--verbose] [--no-live]
                            Fork worker and live-tail events
  mill status <taskId> [--json]
                            Show current task status
  mill watch <taskId> [--json] [--raw] [--verbose] [--no-live]
                            Stream events for a task
  mill cancel <taskId> [--json]
                            Cancel a task (cascades to children)
  mill ls [--all] [--status <status>] [--json] [--quiet]
                            List root tasks; --all for everything

Options:
  --tasks-dir <path>        Tasks directory (default: ~/.mill/tasks)
  --json                   Stable machine-readable JSON output
  --quiet                  Minimal shell-friendly output where useful
  --raw                    For watch, preserve raw NDJSON event streaming
  --verbose, -v            For watch, show full ids, tool arguments/results, and correlation ids
  --no-live                For watch, use sparse append-only human milestones instead of live TTY
  --no-color               Disable colors in human watch output
  --shallow                Scope watch to task only (no subtree)
  --include <types>        Comma-separated event types to include
  --exclude <types>        Comma-separated event types to exclude
  --sync                   Run in-process until terminal
  --foreground, -f         Run program in current process with live output (no fork)
  --watch, -w              After fork, attach event stream (like mill watch)
  --status <status>        Filter ls by created, started, completed, failed, or cancelled
  -h, --help               Show this help message
`;

const booleanFlags = new Set([
  "all",
  "foreground",
  "help",
  "json",
  "no-color",
  "no-live",
  "quiet",
  "raw",
  "shallow",
  "sync",
  "verbose",
  "watch",
]);

const valueFlags = new Set(["exclude", "include", "status", "tasks-dir"]);

const allowedStatuses = new Set<string>(TaskStatusValues);
const allowedStatusMessage = TaskStatusValues.join(", ");

const isTaskStatus = (value: string): value is TaskStatus => allowedStatuses.has(value);

const isTerminalEvent = (event: TaskEvent): boolean =>
  event.type === "task:completed" ||
  event.type === "task:failed" ||
  event.type === "task:cancelled";

const makeWatchSettledPredicate = (taskId: string, shallow: boolean) => {
  let targetTerminal = false;
  const openDescendants = new Set<string>();

  return (event: TaskEvent): boolean => {
    if (!shallow && event.type === "task:child_spawned") {
      openDescendants.add(event.payload.childId);
    }

    if (isTerminalEvent(event)) {
      if (event.taskId === taskId) {
        targetTerminal = true;
      }
      openDescendants.delete(event.taskId);
    }

    return targetTerminal && openDescendants.size === 0;
  };
};

const parseArgs = (
  args: ReadonlyArray<string>,
): { command: string; positional: string[]; flags: Record<string, string | boolean> } => {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
    } else if (arg === "-f") {
      flags.foreground = true;
    } else if (arg === "-v") {
      flags.verbose = true;
    } else if (arg === "-w") {
      flags.watch = true;
    } else if (arg.startsWith("--")) {
      const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
      if (booleanFlags.has(rawKey)) {
        flags[rawKey] = inlineValue === undefined ? true : inlineValue !== "false";
      } else if (valueFlags.has(rawKey)) {
        const next = args[i + 1];
        if (inlineValue !== undefined) {
          flags[rawKey] = inlineValue;
        } else if (next !== undefined && !next.startsWith("-")) {
          flags[rawKey] = next;
          i++;
        } else {
          flags[rawKey] = "";
        }
      } else {
        const next = args[i + 1];
        if (inlineValue !== undefined) {
          flags[rawKey] = inlineValue;
        } else if (next !== undefined && !next.startsWith("-")) {
          flags[rawKey] = next;
          i++;
        } else {
          flags[rawKey] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }

  const command = positional[0] ?? "";
  return { command, positional: positional.slice(1), flags };
};

const taskPaths = (tasksDirectory: string, taskId: string) => ({
  eventsPath: `${tasksDirectory}/${taskId}/events.ndjson`,
  workerLogPath: `${tasksDirectory}/${taskId}/logs/worker.log`,
});

type CliFlags = Record<string, string | boolean>;

const flagList = (value: string | boolean | undefined): ReadonlyArray<string> | undefined =>
  typeof value === "string" ? value.split(",").filter((type) => type.length > 0) : undefined;

const renderEventStream = (
  events: Stream.Stream<TaskEvent, unknown>,
  options: { readonly taskId: string; readonly flags: CliFlags },
): Effect.Effect<void, unknown> => {
  const { taskId, flags } = options;
  const raw = flags.json === true || flags.raw === true;
  if (raw) {
    return Stream.runForEach(events, (event) => printNdjson(event));
  }
  if (process.stdout.isTTY && flags["no-live"] !== true) {
    return runLiveWatch(events, {
      rootTaskId: taskId,
      verbose: flags.verbose === true,
      noColor: flags["no-color"] === true,
    });
  }
  return runMilestoneWatch(events, {
    rootTaskId: taskId,
    verbose: flags.verbose === true,
    noColor: flags["no-color"] === true,
  });
};

const makeWatchStream = (
  mill: Mill,
  taskId: string,
  flags: CliFlags,
): Stream.Stream<TaskEvent, unknown> => {
  const shallow = flags.shallow === true;
  let events = mill
    .watch(taskId, {
      shallow,
    })
    .pipe(Stream.takeUntil(makeWatchSettledPredicate(taskId, shallow)));

  const include = flagList(flags.include);
  if (include !== undefined) {
    const includeSet = new Set(include);
    events = events.pipe(Stream.filter((event) => includeSet.has(event.type)));
  }

  const exclude = flagList(flags.exclude);
  if (exclude !== undefined) {
    const excludeSet = new Set(exclude);
    events = events.pipe(Stream.filter((event) => !excludeSet.has(event.type)));
  }

  return events;
};

const mainEffect = (args: ReadonlyArray<string>): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    const { command, positional, flags } = parseArgs(args);
    const json = flags.json === true;
    const quiet = flags.quiet === true;

    if (command === "__worker") {
      return yield* workerMainEffect(positional);
    }

    if (flags.help || command === "") {
      yield* print(usage);
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
          yield* printError("Error: program path required");
          return 1;
        }

        if (flags.foreground === true && flags.watch === true) {
          yield* printError("Error: --foreground and --watch are mutually exclusive");
          return 1;
        }

        if (flags.foreground === true) {
          return yield* runMill(
            Effect.gen(function* () {
              const mill = yield* Mill;
              const taskId = yield* mill.submit(programPath);
              yield* renderEventStream(makeWatchStream(mill, taskId, flags), { taskId, flags });
              const inspection = yield* mill.inspect(taskId);
              return inspection.status === "completed" ? 0 : 1;
            }),
          );
        }

        if (flags.watch === true) {
          const taskId = yield* runMill(
            Effect.gen(function* () {
              const mill = yield* Mill;
              return yield* mill.prepare(programPath);
            }),
          );
          yield* Effect.provide(
            Effect.scoped(launchDetachedWorker({ taskId, programPath, tasksDirectory })),
            BunServices.layer,
          );
          yield* runMill(
            Effect.gen(function* () {
              const mill = yield* Mill;
              yield* renderEventStream(makeWatchStream(mill, taskId, flags), { taskId, flags });
            }),
          );
          return 0;
        }

        const runResult = yield* runMill(
          Effect.gen(function* () {
            const mill = yield* Mill;
            if (flags.sync === true) {
              const taskId = yield* mill.submit(programPath);
              yield* mill.result(taskId);
              const inspection = yield* mill.inspect(taskId);
              return { taskId, inspection };
            }

            const taskId = yield* mill.prepare(programPath);
            return { taskId, inspection: undefined };
          }),
        );

        const { taskId } = runResult;
        if (flags.sync !== true) {
          yield* Effect.provide(
            Effect.scoped(launchDetachedWorker({ taskId, programPath, tasksDirectory })),
            BunServices.layer,
          );
        }

        const paths = taskPaths(tasksDirectory, taskId);
        if (json) {
          const basePayload = {
            taskId,
            program: programPath,
            status: runResult.inspection?.status ?? "started",
            eventsPath: paths.eventsPath,
            watchCommand: `mill watch ${taskId}`,
          };
          yield* printJson(
            runResult.inspection === undefined
              ? { ...basePayload, workerLogPath: paths.workerLogPath }
              : runResult.inspection.result === undefined
                ? basePayload
                : { ...basePayload, result: runResult.inspection.result },
          );
        } else if (quiet) {
          yield* print(taskId);
        } else if (runResult.inspection !== undefined) {
          yield* print(formatStatus(runResult.inspection));
        } else {
          yield* print(formatRunStarted({ taskId, program: programPath, tasksDirectory }));
        }
        return 0;
      }

      case "status": {
        const taskId = positional[0];
        if (!taskId) {
          yield* printError("Error: taskId required");
          return 1;
        }
        const inspection = yield* runMill(
          Effect.gen(function* () {
            const mill = yield* Mill;
            return yield* mill.inspect(taskId);
          }),
        );
        if (json) {
          yield* printJson(inspection);
        } else {
          yield* print(formatStatus(inspection));
        }
        return 0;
      }

      case "watch": {
        const taskId = positional[0];
        if (!taskId) {
          yield* printError("Error: taskId required");
          return 1;
        }
        yield* runMill(
          Effect.gen(function* () {
            const mill = yield* Mill;
            yield* renderEventStream(makeWatchStream(mill, taskId, flags), { taskId, flags });
          }),
        );
        return 0;
      }

      case "cancel": {
        const taskId = positional[0];
        if (!taskId) {
          yield* printError("Error: taskId required");
          return 1;
        }
        yield* runMill(
          Effect.gen(function* () {
            const mill = yield* Mill;
            return yield* mill.cancel(taskId);
          }),
        );
        yield* Effect.provide(
          Effect.scoped(stopDetachedWorker(tasksDirectory, taskId)),
          BunServices.layer,
        );
        if (json) {
          yield* printJson({ taskId, status: "cancelled" });
        }
        return 0;
      }

      case "ls": {
        const statusFlag = flags.status;
        if (
          statusFlag !== undefined &&
          (typeof statusFlag !== "string" || !isTaskStatus(statusFlag))
        ) {
          yield* printError(
            `Invalid status "${String(statusFlag)}". Allowed: ${allowedStatusMessage}`,
          );
          return 1;
        }
        const status: TaskStatus | undefined = statusFlag === undefined ? undefined : statusFlag;
        const summaries = yield* runMill(
          Effect.gen(function* () {
            const mill = yield* Mill;
            return yield* mill.listSummaries({ all: flags.all === true, status });
          }),
        );
        if (json) {
          yield* printJson({ tasks: summaries });
        } else if (quiet) {
          yield* print(summaries.map((summary) => summary.taskId).join("\n"));
        } else {
          yield* print(formatTaskSummaryTable(summaries));
        }
        return 0;
      }

      default: {
        yield* printError(`Unknown command: ${command}`);
        yield* print(usage);
        return 1;
      }
    }
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.gen(function* () {
        const message = String(error);
        const { flags } = parseArgs(args);
        if (flags.json === true) {
          yield* printError(JSON.stringify({ error: message }));
        } else {
          yield* printError(message);
        }
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
