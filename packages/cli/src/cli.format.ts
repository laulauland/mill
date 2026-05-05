import type { TaskEvent } from "@mill/core";
import type { TaskInspection, TaskSummary } from "@mill/core";

const homePrefix = `${process.env.HOME ?? ""}/`;

const displayPath = (path: string): string =>
  homePrefix.length > 1 && path.startsWith(homePrefix)
    ? `~/${path.slice(homePrefix.length)}`
    : path;

const formatDate = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
};

const formatRelativeTime = (iso: string): string => {
  const date = new Date(iso);
  const elapsedMs = Date.now() - date.getTime();
  if (Number.isNaN(elapsedMs)) {
    return iso;
  }
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const formatDuration = (startIso: string, endIso: string): string => {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return "unknown";
  }
  const totalSeconds = Math.floor((end - start) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

const pad = (value: string, width: number): string => value.padEnd(width, " ");

export const formatRunStarted = (options: {
  readonly taskId: string;
  readonly program: string;
  readonly tasksDirectory: string;
}): string => {
  const taskDirectory = `${options.tasksDirectory}/${options.taskId}`;
  return [
    `Started ${options.taskId}`,
    `Program: ${options.program}`,
    `Events:  ${displayPath(`${taskDirectory}/events.ndjson`)}`,
    `Logs:    ${displayPath(`${taskDirectory}/logs/worker.log`)}`,
    "",
    "Watch:",
    `  mill watch ${options.taskId}`,
    "",
    "Status:",
    `  mill status ${options.taskId}`,
  ].join("\n");
};

export const formatTaskSummaryTable = (summaries: ReadonlyArray<TaskSummary>): string => {
  if (summaries.length === 0) {
    return "No tasks found.";
  }
  const taskIdWidth = Math.max(
    "TASK ID".length,
    ...summaries.map((summary) => summary.taskId.length),
  );
  const statusWidth = Math.max(
    "STATUS".length,
    ...summaries.map((summary) => summary.status.length),
  );
  const updatedWidth = Math.max(
    "UPDATED".length,
    ...summaries.map((summary) => formatRelativeTime(summary.updatedAt).length),
  );
  const lines = [
    `${pad("TASK ID", taskIdWidth)}  ${pad("STATUS", statusWidth)}  ${pad("UPDATED", updatedWidth)}  PROGRAM`,
  ];
  for (const summary of summaries) {
    lines.push(
      `${pad(summary.taskId, taskIdWidth)}  ${pad(summary.status, statusWidth)}  ${pad(formatRelativeTime(summary.updatedAt), updatedWidth)}  ${summary.input ?? ""}`,
    );
  }
  return lines.join("\n");
};

export const formatStatus = (inspection: TaskInspection): string => {
  const lines = [`${inspection.taskId} ${inspection.status}`, ""];
  if (inspection.input !== undefined) {
    lines.push(`Program:   ${inspection.input}`);
  }
  lines.push(`Started:   ${formatDate(inspection.createdAt)}`);
  if (
    inspection.status === "completed" ||
    inspection.status === "failed" ||
    inspection.status === "cancelled"
  ) {
    lines.push(`Finished:  ${formatDate(inspection.updatedAt)}`);
    lines.push(`Duration:  ${formatDuration(inspection.createdAt, inspection.updatedAt)}`);
  } else {
    lines.push(`Updated:   ${formatDate(inspection.updatedAt)}`);
  }
  lines.push(`Children:  ${inspection.children}`);
  if (inspection.result !== undefined && inspection.result.length > 0) {
    lines.push("Result:");
    for (const line of inspection.result.split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  return lines.join("\n");
};

export const formatWatchEvent = (event: TaskEvent): string => {
  switch (event.type) {
    case "task:created":
      return `● ${event.taskId} created ${event.payload.kind}${event.payload.input ? ` ${event.payload.input}` : ""}`;
    case "task:started":
      return `● ${event.taskId} started`;
    case "task:child_spawned":
      return `├─ ${event.payload.childId} ${event.payload.kind} spawned`;
    case "task:turn_started":
      return `├─ ${event.taskId} turn started`;
    case "task:message_chunk":
      return event.payload.text;
    case "task:thought_chunk":
      return `Thinking… ${event.payload.text}`;
    case "task:tool_called":
      return `├─ ${event.taskId} called ${event.payload.toolName}`;
    case "task:tool_returned":
      return `├─ ${event.taskId} returned ${event.payload.toolName}`;
    case "task:turn_completed":
      return `├─ ${event.taskId} turn completed`;
    case "task:completed":
      return `● ${event.taskId} completed`;
    case "task:failed":
      return `● ${event.taskId} failed: ${event.payload.error}`;
    case "task:cancelled":
      return `● ${event.taskId} cancelled${event.payload.reason ? `: ${event.payload.reason}` : ""}`;
  }
};
