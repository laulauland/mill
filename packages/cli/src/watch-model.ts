import type { TaskEvent, TaskStatus } from "@mill/core";

export type WatchToolCall = {
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly arguments?: Record<string, unknown>;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly result?: string;
};

export type WatchChild = {
  readonly taskId: string;
  readonly parentId?: string;
  readonly kind: "program" | "agent";
  readonly label?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly status: TaskStatus;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly currentTurnSequence?: number;
  readonly thought: string;
  readonly output: string;
  readonly tools: ReadonlyArray<WatchToolCall>;
  readonly result?: string;
  readonly error?: string;
};

export type WatchModel = {
  readonly rootTaskId: string;
  readonly program?: string;
  readonly status: TaskStatus;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly childOrder: ReadonlyArray<string>;
  readonly children: ReadonlyMap<string, WatchChild>;
  readonly result?: string;
  readonly error?: string;
};

export const initialWatchModel = (rootTaskId: string): WatchModel => ({
  rootTaskId,
  status: "created",
  childOrder: [],
  children: new Map(),
});

const appendText = (current: string, chunk: string): string => `${current}${chunk}`;

const defaultChild = (
  taskId: string,
  options: {
    readonly parentId?: string;
    readonly kind?: "program" | "agent";
    readonly label?: string;
    readonly provider?: string;
    readonly model?: string;
  } = {},
): WatchChild => ({
  taskId,
  parentId: options.parentId,
  kind: options.kind ?? "agent",
  label: options.label,
  provider: options.provider,
  model: options.model,
  status: "created",
  thought: "",
  output: "",
  tools: [],
});

const childLabel = (event: Extract<TaskEvent, { type: "task:created" }>): string | undefined => {
  if (event.payload.kind === "program") {
    return event.payload.input;
  }
  return undefined;
};

const ensureChild = (model: WatchModel, taskId: string): WatchChild =>
  model.children.get(taskId) ?? defaultChild(taskId);

const putChild = (model: WatchModel, child: WatchChild): WatchModel => {
  const children = new Map(model.children);
  children.set(child.taskId, child);
  const childOrder = model.childOrder.includes(child.taskId)
    ? model.childOrder
    : [...model.childOrder, child.taskId];
  return { ...model, children, childOrder };
};

const terminalStatus = (event: TaskEvent): TaskStatus | undefined => {
  switch (event.type) {
    case "task:completed":
      return "completed";
    case "task:failed":
      return "failed";
    case "task:cancelled":
      return "cancelled";
    default:
      return undefined;
  }
};

const toolCallId = (
  event: Extract<TaskEvent, { type: "task:tool_called" | "task:tool_returned" }>,
): string | undefined => ("toolCallId" in event.payload ? event.payload.toolCallId : undefined);

const updateToolReturned = (
  tools: ReadonlyArray<WatchToolCall>,
  event: Extract<TaskEvent, { type: "task:tool_returned" }>,
): ReadonlyArray<WatchToolCall> => {
  const id = toolCallId(event);
  const index = [...tools]
    .map((tool, toolIndex) => ({ tool, toolIndex }))
    .reverse()
    .find(
      ({ tool }) =>
        tool.completedAt === undefined &&
        (id !== undefined ? tool.toolCallId === id : tool.toolName === event.payload.toolName),
    )?.toolIndex;

  if (index === undefined) {
    return [
      ...tools,
      {
        toolCallId: id,
        toolName: event.payload.toolName,
        startedAt: event.timestamp,
        completedAt: event.timestamp,
        result: event.payload.result,
      },
    ];
  }

  return tools.map((tool, toolIndex) =>
    toolIndex === index
      ? { ...tool, completedAt: event.timestamp, result: event.payload.result }
      : tool,
  );
};

export const reduceWatchEvent = (model: WatchModel, event: TaskEvent): WatchModel => {
  if (event.taskId === model.rootTaskId) {
    switch (event.type) {
      case "task:created":
        return {
          ...model,
          program: event.payload.input ?? model.program,
          status: "created",
          createdAt: event.timestamp,
        };
      case "task:started":
        return { ...model, status: "started", startedAt: event.timestamp };
      case "task:child_spawned":
        return putChild(
          model,
          defaultChild(event.payload.childId, {
            parentId: event.taskId,
            kind: event.payload.kind,
            label: event.payload.label,
            provider: event.payload.provider,
            model: event.payload.model,
          }),
        );
      case "task:completed":
        return {
          ...model,
          status: "completed",
          completedAt: event.timestamp,
          result: event.payload.result,
        };
      case "task:failed":
        return {
          ...model,
          status: "failed",
          completedAt: event.timestamp,
          error: event.payload.error,
        };
      case "task:cancelled":
        return {
          ...model,
          status: "cancelled",
          completedAt: event.timestamp,
          error: event.payload.reason,
        };
      default:
        break;
    }
  }

  if (event.taskId === model.rootTaskId) {
    return model;
  }

  const existing = ensureChild(model, event.taskId);
  let child: WatchChild = existing;
  switch (event.type) {
    case "task:created":
      child = {
        ...child,
        parentId: event.payload.parentId ?? child.parentId,
        kind: event.payload.kind,
        label: child.label ?? childLabel(event),
        createdAt: event.timestamp,
        status: "created",
      };
      break;
    case "task:started":
      child = { ...child, status: "started", startedAt: event.timestamp };
      break;
    case "task:turn_started":
      child = {
        ...child,
        currentTurnSequence: event.payload.sequence,
        thought: "",
        output: "",
      };
      break;
    case "task:thought_chunk":
      child = { ...child, thought: appendText(child.thought, event.payload.text) };
      break;
    case "task:message_chunk":
      child = { ...child, output: appendText(child.output, event.payload.text) };
      break;
    case "task:tool_called":
      child = {
        ...child,
        tools: [
          ...child.tools,
          {
            toolCallId: toolCallId(event),
            toolName: event.payload.toolName,
            arguments: event.payload.arguments,
            startedAt: event.timestamp,
          },
        ],
      };
      break;
    case "task:tool_returned":
      child = { ...child, tools: updateToolReturned(child.tools, event) };
      break;
    case "task:completed":
      child = {
        ...child,
        status: "completed",
        completedAt: event.timestamp,
        result: event.payload.result,
      };
      break;
    case "task:failed":
      child = {
        ...child,
        status: "failed",
        completedAt: event.timestamp,
        error: event.payload.error,
      };
      break;
    case "task:cancelled":
      child = {
        ...child,
        status: "cancelled",
        completedAt: event.timestamp,
        error: event.payload.reason,
      };
      break;
    case "task:child_spawned":
    case "task:turn_completed":
      break;
  }

  const status = terminalStatus(event);
  if (status !== undefined) {
    child = { ...child, status, completedAt: event.timestamp };
  }

  return putChild(model, child);
};
