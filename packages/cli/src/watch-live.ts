import { Effect, Stream } from "effect";
import type { TaskEvent } from "@mill/core";
import { initialWatchModel, reduceWatchEvent, type WatchModel } from "./watch-model";
import { renderWatchMilestone, renderWatchModel } from "./watch-render";
import { print, writeStdout } from "./cli.output";

export type WatchRuntimeOptions = {
  readonly rootTaskId: string;
  readonly verbose?: boolean;
  readonly noColor?: boolean;
  readonly noLive?: boolean;
};

const hideCursor = "\x1b[?25l";
const showCursor = "\x1b[?25h";
const clearBelow = "\x1b[J";

const lineCount = (text: string): number => (text.length === 0 ? 0 : text.split("\n").length);

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
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    let model = initialWatchModel(options.rootTaskId);
    let renderedLines = 0;
    yield* writeStdout(hideCursor);
    yield* Stream.runForEach(events, (event) =>
      Effect.gen(function* () {
        model = reduceWatchEvent(model, event);
        const rendered = renderWatchModel(model, renderOptions(options));
        const moveUp = renderedLines > 0 ? `\x1b[${renderedLines}A` : "";
        yield* writeStdout(`${moveUp}${clearBelow}${rendered}\n`);
        renderedLines = lineCount(rendered);
      }),
    ).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* writeStdout(showCursor);
        }),
      ),
    );
  });

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
