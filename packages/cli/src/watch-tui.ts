import { Effect, Stream } from "effect";
import { TUI, truncateToWidth, type Component, type Terminal } from "@mariozechner/pi-tui";
import type { TaskEvent } from "@mill/core";
import { initialWatchModel, reduceWatchEvent, type WatchModel } from "./watch-model";
import { renderWatchModel } from "./watch-render";
import type { WatchRuntimeOptions } from "./watch-live";

class WatchComponent implements Component {
  private model: WatchModel;
  private cachedWidth = 0;
  private cachedRows = 0;
  private cachedLines: string[] | undefined;

  constructor(
    rootTaskId: string,
    private readonly options: WatchRuntimeOptions,
    private readonly rows: () => number,
  ) {
    this.model = initialWatchModel(rootTaskId);
  }

  applyEvent(event: TaskEvent): void {
    this.model = reduceWatchEvent(this.model, event);
    this.invalidate();
  }

  invalidate(): void {
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    const rows = Math.max(8, this.rows());
    if (this.cachedLines !== undefined && this.cachedWidth === width && this.cachedRows === rows) {
      return this.cachedLines;
    }

    const rendered = renderWatchModel(this.model, {
      columns: width,
      rows,
      verbose: this.options.verbose === true,
      // TODO: thread noColor through watch-render if human watch output adds ANSI color.
    });
    const renderedLines = rendered.split("\n").map((line) => truncateToWidth(line, width));
    const lines = renderedLines.slice(Math.max(0, renderedLines.length - rows));

    this.cachedWidth = width;
    this.cachedRows = rows;
    this.cachedLines = lines;
    return lines;
  }
}

// Use a minimal terminal adapter instead of pi-tui's interactive ProcessTerminal.
// Live watch is display-only; avoiding keyboard-protocol probes prevents delayed
// terminal-mode enable sequences from racing after short completed-task replays.
class WatchTerminal implements Terminal {
  private wasRaw = false;
  private inputHandler: ((data: string) => void) | undefined;
  private resizeHandler: (() => void) | undefined;
  private stdinDataHandler: ((data: string) => void) | undefined;

  get kittyProtocolActive(): boolean {
    return false;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
    this.wasRaw = process.stdin.isRaw || false;
    process.stdin.setRawMode?.(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdout.write("\x1b[?2004h");
    process.stdout.on("resize", this.resizeHandler);
    this.stdinDataHandler = (data) => this.inputHandler?.(data);
    process.stdin.on("data", this.stdinDataHandler);
  }

  stop(): void {
    process.stdout.write("\x1b[?2004l");
    if (this.stdinDataHandler !== undefined) {
      process.stdin.removeListener("data", this.stdinDataHandler);
      this.stdinDataHandler = undefined;
    }
    if (this.resizeHandler !== undefined) {
      process.stdout.removeListener("resize", this.resizeHandler);
      this.resizeHandler = undefined;
    }
    this.inputHandler = undefined;
    process.stdin.pause();
    process.stdin.setRawMode?.(this.wasRaw);
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    process.stdout.write(data);
  }

  get columns(): number {
    return process.stdout.columns || Number(process.env.COLUMNS) || 80;
  }

  get rows(): number {
    return process.stdout.rows || Number(process.env.LINES) || 24;
  }

  moveBy(lines: number): void {
    if (lines > 0) process.stdout.write(`\x1b[${lines}B`);
    if (lines < 0) process.stdout.write(`\x1b[${-lines}A`);
  }

  hideCursor(): void {
    process.stdout.write("\x1b[?25l");
  }

  showCursor(): void {
    process.stdout.write("\x1b[?25h");
  }

  clearLine(): void {
    process.stdout.write("\x1b[K");
  }

  clearFromCursor(): void {
    process.stdout.write("\x1b[J");
  }

  clearScreen(): void {
    process.stdout.write("\x1b[2J\x1b[H");
  }

  setTitle(title: string): void {
    process.stdout.write(`\x1b]0;${title}\x07`);
  }

  setProgress(_active: boolean): void {}
}

const renderBeforeStop = (tui: TUI): Effect.Effect<void> =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        tui.requestRender(true);
        process.nextTick(resolve);
      }),
  );

export const runTuiWatch = (
  events: Stream.Stream<TaskEvent, unknown>,
  options: WatchRuntimeOptions,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const terminal = new WatchTerminal();
    const tui = new TUI(terminal, false);
    const component = new WatchComponent(options.rootTaskId, options, () => terminal.rows);
    tui.addChild(component);

    const removeInputListener = tui.addInputListener((data) => {
      if (data === "\x03") {
        process.kill(process.pid, "SIGINT");
        return { consume: true };
      }
      return undefined;
    });

    tui.start();

    yield* Stream.runForEach(events, (event) =>
      Effect.sync(() => {
        component.applyEvent(event);
        tui.requestRender();
      }),
    ).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* renderBeforeStop(tui);
          removeInputListener();
          tui.stop();
        }),
      ),
    );
  });
