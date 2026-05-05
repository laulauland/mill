import { Effect, Stream } from "effect";
import type { TaskEvent } from "@mill/core";
import { initialWatchModel, reduceWatchEvent, type WatchModel } from "./watch-model";
import { renderWatchMilestone } from "./watch-render";
import { print } from "./cli.output";
import { runTuiWatch } from "./watch-tui";

export type WatchRuntimeOptions = {
  readonly rootTaskId: string;
  readonly verbose?: boolean;
  readonly noColor?: boolean;
  readonly noLive?: boolean;
};

const terminalSize = () => ({
  columns: process.stdout.columns ?? 100,
  rows: process.stdout.rows ?? 40,
});

const renderOptions = (options: WatchRuntimeOptions) => ({
  ...terminalSize(),
  verbose: options.verbose === true,
});

export const runLiveWatch = (
  events: Stream.Stream<TaskEvent, unknown>,
  options: WatchRuntimeOptions,
): Effect.Effect<void, unknown> => runTuiWatch(events, options);

export const runMilestoneWatch = (
  events: Stream.Stream<TaskEvent, unknown>,
  options: WatchRuntimeOptions,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    let model = initialWatchModel(options.rootTaskId);
    yield* Stream.runForEach(events, (event) =>
      Effect.gen(function* () {
        const previous: WatchModel = model;
        model = reduceWatchEvent(model, event);
        const milestone = renderWatchMilestone(previous, model, renderOptions(options));
        if (milestone !== undefined) {
          yield* print(milestone);
        }
      }),
    );
  });
