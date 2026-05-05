import type { TaskStatus } from "@mill/core";
import type { WatchChild, WatchModel, WatchToolCall } from "./watch-model";

export type WatchRenderOptions = {
  readonly columns?: number;
  readonly rows?: number;
  readonly verbose?: boolean;
  readonly now?: number;
};

const terminalColumns = 100;

const statusIcon = (status: TaskStatus): string => {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
      return "◼";
    case "started":
      return "●";
    case "created":
      return "○";
  }
};

const parseTime = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const value = new Date(iso).getTime();
  return Number.isNaN(value) ? undefined : value;
};

const durationMs = (
  startIso: string | undefined,
  endIso: string | undefined,
  now: number,
): number | undefined => {
  const start = parseTime(startIso);
  if (start === undefined) return undefined;
  const end = parseTime(endIso) ?? now;
  return Math.max(0, end - start);
};

export const formatElapsed = (ms: number | undefined): string => {
  if (ms === undefined) return "";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  if (minutes < 60) return `${minutes}m ${remainder.toFixed(1)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const truncate = (text: string, width: number, verbose: boolean): string => {
  if (verbose || text.length <= width) return text;
  if (width <= 1) return "…";
  return `${text.slice(0, width - 1)}…`;
};

const row = (left: string, right: string, columns: number, verbose: boolean): string => {
  if (right.length === 0 || verbose) return left;
  const gap = Math.max(1, columns - left.length - right.length);
  if (gap === 1 && left.length + right.length + gap > columns) {
    return `${truncate(left, Math.max(1, columns - right.length - 1), false)} ${right}`;
  }
  return `${left}${" ".repeat(gap)}${right}`;
};

const toolTitle = (tool: WatchToolCall, verbose: boolean): string => {
  if (!verbose) return oneLine(tool.toolName);
  const args = tool.arguments === undefined ? "" : ` ${JSON.stringify(tool.arguments)}`;
  const id = tool.toolCallId === undefined ? "" : ` [${tool.toolCallId}]`;
  const result = tool.result === undefined ? "" : ` → ${oneLine(tool.result)}`;
  return `${tool.toolName}${id}${args}${result}`;
};

const childLabel = (child: WatchChild, verbose: boolean): string => {
  const agentLabel =
    child.provider !== undefined && child.model !== undefined
      ? `${child.provider} (${child.model})`
      : undefined;
  const base = child.label ?? agentLabel ?? child.kind;
  return verbose ? `${base} ${child.taskId}` : base;
};

const renderChild = (
  child: WatchChild,
  options: Required<WatchRenderOptions>,
): ReadonlyArray<string> => {
  const columns = options.columns;
  const lines: string[] = [];
  const elapsed = formatElapsed(
    durationMs(child.startedAt ?? child.createdAt, child.completedAt, options.now),
  );
  lines.push(row(`├─ ${childLabel(child, options.verbose)}`, elapsed, columns, options.verbose));

  if (child.thought.trim().length > 0) {
    const prefix = "│  ▸ thought  ";
    lines.push(
      `${prefix}${truncate(oneLine(child.thought), Math.max(1, columns - prefix.length), options.verbose)}`,
    );
  }

  for (const tool of child.tools.slice(options.verbose ? 0 : -6)) {
    const elapsedTool = formatElapsed(durationMs(tool.startedAt, tool.completedAt, options.now));
    const prefix = "│  ▸ tool     ";
    const left = `${prefix}${truncate(
      toolTitle(tool, options.verbose),
      Math.max(1, columns - prefix.length - elapsedTool.length - 1),
      options.verbose,
    )}`;
    lines.push(row(left, elapsedTool, columns, options.verbose));
  }

  if (child.output.trim().length > 0) {
    const prefix = "│  ▸ output   ";
    lines.push(
      `${prefix}${truncate(oneLine(child.output), Math.max(1, columns - prefix.length), options.verbose)}`,
    );
  }

  if (child.status === "failed" && child.error !== undefined) {
    const prefix = "│  ▸ error    ";
    lines.push(
      `${prefix}${truncate(oneLine(child.error), Math.max(1, columns - prefix.length), options.verbose)}`,
    );
  }

  return lines;
};

const normalizeOptions = (options: WatchRenderOptions = {}): Required<WatchRenderOptions> => ({
  columns: Math.max(40, options.columns ?? terminalColumns),
  rows: Math.max(8, options.rows ?? 40),
  verbose: options.verbose ?? false,
  now: options.now ?? new Date().getTime(),
});

export const renderWatchModel = (model: WatchModel, options: WatchRenderOptions = {}): string => {
  const resolved = normalizeOptions(options);
  const columns = resolved.columns;
  const program = model.program ?? "watching task";
  const taskId = `taskId: ${model.rootTaskId}`;
  const lines: string[] = [
    row(
      `${statusIcon(model.status)} ${truncate(program, Math.max(1, columns - taskId.length - 3), resolved.verbose)}`,
      taskId,
      columns,
      false,
    ),
    "│",
  ];

  for (const childId of model.childOrder) {
    const child = model.children.get(childId);
    if (child === undefined) continue;
    lines.push(...renderChild(child, resolved), "│");
  }

  if (model.error !== undefined && model.status === "failed") {
    lines.push(
      `✗ failed: ${truncate(oneLine(model.error), Math.max(1, columns - 10), resolved.verbose)}`,
    );
  } else {
    const total = formatElapsed(
      durationMs(model.startedAt ?? model.createdAt, model.completedAt, resolved.now),
    );
    lines.push(
      row(
        `${statusIcon(model.status)} ${model.status}`,
        total.length > 0 ? `${total} total` : "",
        columns,
        false,
      ),
    );
  }

  const bounded = lines.slice(Math.max(0, lines.length - resolved.rows));
  return bounded.join("\n");
};

export const renderWatchMilestone = (
  previous: WatchModel,
  next: WatchModel,
  options: WatchRenderOptions = {},
): string | undefined => {
  const resolved = normalizeOptions(options);

  for (const childId of next.childOrder) {
    const previousChild = previous.children.get(childId);
    const nextChild = next.children.get(childId);
    if (nextChild === undefined) continue;
    if (
      previousChild?.status !== nextChild.status &&
      ["completed", "failed", "cancelled"].includes(nextChild.status)
    ) {
      const elapsed = formatElapsed(
        durationMs(nextChild.startedAt ?? nextChild.createdAt, nextChild.completedAt, resolved.now),
      );
      return row(
        `${statusIcon(nextChild.status)} ${childLabel(nextChild, resolved.verbose)} ${nextChild.status}`,
        elapsed,
        resolved.columns,
        resolved.verbose,
      );
    }
  }

  if (
    previous.status !== next.status &&
    ["completed", "failed", "cancelled"].includes(next.status)
  ) {
    const elapsed = formatElapsed(
      durationMs(next.startedAt ?? next.createdAt, next.completedAt, resolved.now),
    );
    return row(
      `${statusIcon(next.status)} ${next.status}`,
      elapsed.length > 0 ? `${elapsed} total` : "",
      resolved.columns,
      resolved.verbose,
    );
  }

  return undefined;
};
