import type { TaskEvent } from "./schemas/task-event";
import type { TaskSnapshot } from "./schemas/task-state";
import type { TaskStatus } from "./schemas/task-command";

export type ReducerState = {
  readonly snapshot: TaskSnapshot;
  readonly children: ReadonlyArray<string>;
  readonly currentPrompt?: string;
  readonly currentTurnSequence?: number;
};

const initialSnapshot = (taskId: string): TaskSnapshot => ({
  id: taskId,
  status: "created",
  text: "",
  thought: "",
  busy: false,
  history: [],
});

const updateSnapshot = (snapshot: TaskSnapshot, updates: Partial<TaskSnapshot>): TaskSnapshot => ({
  ...snapshot,
  ...updates,
});

export const reduceEvent = (state: ReducerState, event: TaskEvent): ReducerState => {
  switch (event.type) {
    case "task:created": {
      return {
        snapshot: updateSnapshot(state.snapshot, {
          id: event.taskId,
          status: "created",
        }),
        children: state.children,
        currentPrompt: state.currentPrompt,
        currentTurnSequence: state.currentTurnSequence,
      };
    }

    case "task:started": {
      return {
        snapshot: updateSnapshot(state.snapshot, {
          status: "started",
        }),
        children: state.children,
        currentPrompt: state.currentPrompt,
        currentTurnSequence: state.currentTurnSequence,
      };
    }

    case "task:turn_started": {
      return {
        snapshot: updateSnapshot(state.snapshot, {
          text: "",
          thought: "",
          busy: true,
          pending: undefined,
        }),
        children: state.children,
        currentPrompt: event.payload.prompt,
        currentTurnSequence: event.payload.sequence,
      };
    }

    case "task:turn_completed": {
      return {
        snapshot: updateSnapshot(state.snapshot, {
          text: event.payload.text,
          busy: false,
          history: [
            ...state.snapshot.history,
            { prompt: state.currentPrompt ?? "", text: event.payload.text },
          ],
        }),
        children: state.children,
        currentPrompt: undefined,
        currentTurnSequence: undefined,
      };
    }

    case "task:child_spawned": {
      return {
        snapshot: state.snapshot,
        children: [...state.children, event.payload.childId],
        currentPrompt: state.currentPrompt,
        currentTurnSequence: state.currentTurnSequence,
      };
    }

    case "task:message_chunk": {
      return {
        snapshot: updateSnapshot(state.snapshot, {
          text: state.snapshot.text + event.payload.text,
        }),
        children: state.children,
        currentPrompt: state.currentPrompt,
        currentTurnSequence: state.currentTurnSequence,
      };
    }

    case "task:thought_chunk": {
      return {
        snapshot: updateSnapshot(state.snapshot, {
          thought: state.snapshot.thought + event.payload.text,
        }),
        children: state.children,
        currentPrompt: state.currentPrompt,
        currentTurnSequence: state.currentTurnSequence,
      };
    }

    case "task:tool_called":
    case "task:tool_returned": {
      return {
        snapshot: state.snapshot,
        children: state.children,
        currentPrompt: state.currentPrompt,
        currentTurnSequence: state.currentTurnSequence,
      };
    }

    case "task:completed": {
      return {
        snapshot: updateSnapshot(state.snapshot, {
          status: "completed",
          busy: false,
          output: event.payload.output ?? {
            kind: "agent",
            text: event.payload.result ?? "",
          },
        }),
        children: state.children,
        currentPrompt: state.currentPrompt,
        currentTurnSequence: state.currentTurnSequence,
      };
    }

    case "task:failed": {
      return {
        snapshot: updateSnapshot(state.snapshot, {
          status: "failed",
          busy: false,
        }),
        children: state.children,
        currentPrompt: state.currentPrompt,
        currentTurnSequence: state.currentTurnSequence,
      };
    }

    case "task:cancelled": {
      return {
        snapshot: updateSnapshot(state.snapshot, {
          status: "cancelled",
          busy: false,
        }),
        children: state.children,
        currentPrompt: state.currentPrompt,
        currentTurnSequence: state.currentTurnSequence,
      };
    }

    default: {
      return state;
    }
  }
};

export const reduceEvents = (taskId: string, events: ReadonlyArray<TaskEvent>): ReducerState => {
  let state: ReducerState = {
    snapshot: initialSnapshot(taskId),
    children: [],
  };

  for (const event of events) {
    state = reduceEvent(state, event);
  }

  return state;
};

export const isTerminalStatus = (status: TaskStatus): boolean =>
  status === "completed" || status === "failed" || status === "cancelled";
