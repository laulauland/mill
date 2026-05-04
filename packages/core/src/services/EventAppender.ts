import * as FileSystem from "effect/FileSystem";
import { Context, Data, Effect, Layer, PlatformError, PubSub, Ref, Schedule, Stream } from "effect";
import type { TaskEvent } from "../schemas/task-event";
import { reduceEvent, isTerminalStatus, type ReducerState } from "../task-reducer";
import { PathService } from "./PathService";
import { encodeEvent, decodeEvent } from "../schemas/task-event.codec";

export class EventAppendError extends Data.TaggedError("EventAppendError")<{
  readonly rootTaskId: string;
  readonly event: TaskEvent;
  readonly message: string;
}> {}

export class LifecycleValidationError extends Data.TaggedError("LifecycleValidationError")<{
  readonly rootTaskId: string;
  readonly event: TaskEvent;
  readonly currentStatus: string;
  readonly message: string;
}> {}

export type EventAppender = {
  readonly append: (
    rootTaskId: string,
    event: TaskEvent,
  ) => Effect.Effect<
    TaskEvent,
    EventAppendError | LifecycleValidationError | PlatformError.PlatformError
  >;

  readonly readEvents: (
    rootTaskId: string,
  ) => Effect.Effect<ReadonlyArray<TaskEvent>, EventAppendError | PlatformError.PlatformError>;

  readonly listRootTaskIds: () => Effect.Effect<
    ReadonlyArray<string>,
    EventAppendError | PlatformError.PlatformError
  >;

  readonly watch: (rootTaskId: string) => Stream.Stream<TaskEvent>;

  readonly watchFromFile: (
    rootTaskId: string,
  ) => Stream.Stream<TaskEvent, EventAppendError | PlatformError.PlatformError>;

  readonly resolveRootTaskId: (
    taskId: string,
  ) => Effect.Effect<string | undefined, EventAppendError | PlatformError.PlatformError>;
};

const joinPath = (base: string, child: string): string =>
  base.endsWith("/") ? `${base}${child}` : `${base}/${child}`;

const rootTaskDir = (tasksDirectory: string, rootTaskId: string): string =>
  joinPath(tasksDirectory, rootTaskId);

const eventsFilePath = (tasksDirectory: string, rootTaskId: string): string =>
  joinPath(rootTaskDir(tasksDirectory, rootTaskId), "events.ndjson");

const snapshotDir = (tasksDirectory: string, rootTaskId: string): string =>
  joinPath(rootTaskDir(tasksDirectory, rootTaskId), "tasks");

const snapshotFilePath = (tasksDirectory: string, rootTaskId: string, childId: string): string =>
  joinPath(snapshotDir(tasksDirectory, rootTaskId), `${childId}.json`);

const validateLifecycleTransition = (
  rootTaskId: string,
  event: TaskEvent,
  currentState: ReducerState,
): Effect.Effect<void, LifecycleValidationError> => {
  const status = currentState.snapshot.status;

  if (event.type === "task:started" && status !== "created") {
    return Effect.fail(
      new LifecycleValidationError({
        rootTaskId,
        event,
        currentStatus: status,
        message: "Can only start a task in created state",
      }),
    );
  }

  if (isTerminalStatus(status)) {
    return Effect.fail(
      new LifecycleValidationError({
        rootTaskId,
        event,
        currentStatus: status,
        message: "Cannot append events after terminal status",
      }),
    );
  }

  if (event.type === "task:turn_started") {
    if (status !== "started") {
      return Effect.fail(
        new LifecycleValidationError({
          rootTaskId,
          event,
          currentStatus: status,
          message: "Can only start a turn in started state",
        }),
      );
    }

    if (currentState.snapshot.busy) {
      return Effect.fail(
        new LifecycleValidationError({
          rootTaskId,
          event,
          currentStatus: status,
          message: "Cannot start a turn while another turn is active",
        }),
      );
    }
  }

  if (event.type === "task:turn_completed") {
    if (!currentState.snapshot.busy) {
      return Effect.fail(
        new LifecycleValidationError({
          rootTaskId,
          event,
          currentStatus: status,
          message: "Cannot complete a turn when no turn is active",
        }),
      );
    }

    if (currentState.currentTurnSequence !== event.payload.sequence) {
      return Effect.fail(
        new LifecycleValidationError({
          rootTaskId,
          event,
          currentStatus: status,
          message: "Cannot complete a turn with a mismatched sequence",
        }),
      );
    }
  }

  if (event.type === "task:completed" && currentState.snapshot.busy) {
    return Effect.fail(
      new LifecycleValidationError({
        rootTaskId,
        event,
        currentStatus: status,
        message: "Cannot complete a task while a turn is active",
      }),
    );
  }

  if (
    (event.type === "task:completed" ||
      event.type === "task:failed" ||
      event.type === "task:cancelled") &&
    isTerminalStatus(status)
  ) {
    return Effect.fail(
      new LifecycleValidationError({
        rootTaskId,
        event,
        currentStatus: status,
        message: "Cannot transition from terminal status",
      }),
    );
  }

  return Effect.void;
};

const buildInitialState = (taskId: string): ReducerState => ({
  snapshot: {
    id: taskId,
    status: "created",
    text: "",
    thought: "",
    busy: false,
    history: [],
  },
  children: [],
});

const placeholderEvent = (rootTaskId: string): TaskEvent => ({
  type: "task:created",
  taskId: rootTaskId,
  sequence: 0,
  timestamp: "",
  payload: {
    kind: "program",
  },
});

interface PerRootState {
  readonly sequenceRef: Ref.Ref<number>;
  readonly statesRef: Ref.Ref<Map<string, ReducerState>>;
  readonly rootByTaskRef: Ref.Ref<Map<string, string>>;
}

export type MakeEventAppenderInput = {
  readonly tasksDirectory: string;
};

export const makeEventAppender = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const pubSub = yield* PubSub.unbounded<TaskEvent>();

  const perRootMap = new Map<string, PerRootState>();

  const getOrCreatePerRootState = (rootTaskId: string): Effect.Effect<PerRootState> =>
    Effect.sync(() => {
      let state = perRootMap.get(rootTaskId);

      if (state === undefined) {
        const sequenceRef = Ref.makeUnsafe(0);
        const statesRef = Ref.makeUnsafe(new Map([[rootTaskId, buildInitialState(rootTaskId)]]));
        const rootByTaskRef = Ref.makeUnsafe(new Map([[rootTaskId, rootTaskId]]));
        state = { sequenceRef, statesRef, rootByTaskRef };
        perRootMap.set(rootTaskId, state);
      }

      return state;
    });

  const ensureEventsFile = (
    rootTaskId: string,
  ): Effect.Effect<void, EventAppendError | PlatformError.PlatformError> =>
    Effect.gen(function* () {
      const dir = rootTaskDir(tasksDirectory, rootTaskId);
      const file = eventsFilePath(tasksDirectory, rootTaskId);
      const exists = yield* fileSystem.exists(file);

      if (!exists) {
        yield* fileSystem.makeDirectory(dir, { recursive: true }).pipe(
          Effect.mapError(
            (error) =>
              new EventAppendError({
                rootTaskId,
                event: placeholderEvent(rootTaskId),
                message: `Failed to create task directory: ${String(error)}`,
              }),
          ),
        );

        yield* fileSystem.writeFileString(file, "").pipe(
          Effect.mapError(
            (error) =>
              new EventAppendError({
                rootTaskId,
                event: placeholderEvent(rootTaskId),
                message: `Failed to create events file: ${String(error)}`,
              }),
          ),
        );
      }
    });

  const readAndReplayEvents = (
    rootTaskId: string,
  ): Effect.Effect<ReducerState, EventAppendError | PlatformError.PlatformError> =>
    Effect.gen(function* () {
      const file = eventsFilePath(tasksDirectory, rootTaskId);
      const exists = yield* fileSystem.exists(file);

      if (!exists) {
        return buildInitialState(rootTaskId);
      }

      const content = yield* fileSystem.readFileString(file, "utf-8").pipe(
        Effect.mapError(
          (error) =>
            new EventAppendError({
              rootTaskId,
              event: placeholderEvent(rootTaskId),
              message: `Failed to read events file: ${String(error)}`,
            }),
        ),
      );

      const lines = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      let state = buildInitialState(rootTaskId);
      const taskStates = new Map<string, ReducerState>([[rootTaskId, state]]);
      const rootByTask = new Map<string, string>([[rootTaskId, rootTaskId]]);
      let maxSequence = 0;

      for (const line of lines) {
        const event = yield* Effect.mapError(
          decodeEvent(line),
          (error) =>
            new EventAppendError({
              rootTaskId,
              event: placeholderEvent(rootTaskId),
              message: `Failed to decode event: ${error.message}`,
            }),
        );

        const currentTaskState = taskStates.get(event.taskId) ?? buildInitialState(event.taskId);
        const nextTaskState = reduceEvent(currentTaskState, event);
        taskStates.set(event.taskId, nextTaskState);

        if (event.taskId === rootTaskId) {
          state = nextTaskState;
        }

        const knownRoot = rootByTask.get(event.taskId) ?? rootTaskId;
        rootByTask.set(event.taskId, knownRoot);

        if (event.type === "task:child_spawned") {
          rootByTask.set(event.payload.childId, knownRoot);
          if (!taskStates.has(event.payload.childId)) {
            taskStates.set(event.payload.childId, buildInitialState(event.payload.childId));
          }
        }

        if (event.sequence > maxSequence) {
          maxSequence = event.sequence;
        }
      }

      const perRoot = yield* getOrCreatePerRootState(rootTaskId);
      yield* Ref.set(perRoot.sequenceRef, maxSequence);
      yield* Ref.set(perRoot.statesRef, taskStates);
      yield* Ref.set(perRoot.rootByTaskRef, rootByTask);

      return state;
    });

  const writeSnapshot = (
    rootTaskId: string,
    childId: string,
    state: ReducerState,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const dir = snapshotDir(tasksDirectory, rootTaskId);
      const file = snapshotFilePath(tasksDirectory, rootTaskId, childId);

      yield* fileSystem
        .makeDirectory(dir, { recursive: true })
        .pipe(Effect.catch(() => Effect.void));

      yield* fileSystem
        .writeFileString(file, `${JSON.stringify(state.snapshot, null, 2)}\n`)
        .pipe(Effect.catch(() => Effect.void));
    });

  const pathService = yield* PathService;
  const tasksDirectory = yield* pathService.tasksDirectory;

  const append = (
    rootTaskId: string,
    event: TaskEvent,
  ): Effect.Effect<
    TaskEvent,
    EventAppendError | LifecycleValidationError | PlatformError.PlatformError
  > =>
    Effect.gen(function* () {
      yield* ensureEventsFile(rootTaskId);

      const perRoot = yield* getOrCreatePerRootState(rootTaskId);
      let taskStates = yield* Ref.get(perRoot.statesRef);
      let currentState = taskStates.get(event.taskId) ?? buildInitialState(event.taskId);

      if (currentState.snapshot.status === "created" && event.sequence === 1) {
        yield* readAndReplayEvents(rootTaskId);
        taskStates = yield* Ref.get(perRoot.statesRef);
        currentState = taskStates.get(event.taskId) ?? buildInitialState(event.taskId);
      }

      yield* validateLifecycleTransition(rootTaskId, event, currentState);

      const nextSequence = yield* Ref.updateAndGet(perRoot.sequenceRef, (n) => n + 1);
      const eventWithSequence: TaskEvent = { ...event, sequence: nextSequence };

      const nextState = reduceEvent(currentState, eventWithSequence);
      const nextTaskStates = new Map(taskStates);
      nextTaskStates.set(eventWithSequence.taskId, nextState);

      const rootByTask = new Map(yield* Ref.get(perRoot.rootByTaskRef));
      const taskRoot = rootByTask.get(eventWithSequence.taskId) ?? rootTaskId;
      rootByTask.set(eventWithSequence.taskId, taskRoot);

      if (eventWithSequence.type === "task:child_spawned") {
        rootByTask.set(eventWithSequence.payload.childId, taskRoot);
        if (!nextTaskStates.has(eventWithSequence.payload.childId)) {
          nextTaskStates.set(
            eventWithSequence.payload.childId,
            buildInitialState(eventWithSequence.payload.childId),
          );
        }
      }

      yield* Ref.set(perRoot.statesRef, nextTaskStates);
      yield* Ref.set(perRoot.rootByTaskRef, rootByTask);

      const file = eventsFilePath(tasksDirectory, rootTaskId);
      yield* fileSystem
        .writeFileString(file, `${encodeEvent(eventWithSequence)}\n`, { flag: "a" })
        .pipe(
          Effect.mapError(
            (error) =>
              new EventAppendError({
                rootTaskId,
                event: eventWithSequence,
                message: `Failed to append event: ${String(error)}`,
              }),
          ),
        );

      yield* PubSub.publish(pubSub, eventWithSequence);

      const childId =
        eventWithSequence.type === "task:child_spawned"
          ? eventWithSequence.payload.childId
          : eventWithSequence.taskId !== rootTaskId
            ? eventWithSequence.taskId
            : null;

      if (childId !== null) {
        yield* writeSnapshot(
          rootTaskId,
          childId,
          nextTaskStates.get(childId) ?? buildInitialState(childId),
        );
      }

      return eventWithSequence;
    });

  const readEvents = (
    rootTaskId: string,
  ): Effect.Effect<ReadonlyArray<TaskEvent>, EventAppendError | PlatformError.PlatformError> =>
    Effect.gen(function* () {
      yield* readAndReplayEvents(rootTaskId);

      const file = eventsFilePath(tasksDirectory, rootTaskId);
      const exists = yield* fileSystem.exists(file);

      if (!exists) {
        return [];
      }

      const content = yield* fileSystem.readFileString(file, "utf-8").pipe(
        Effect.mapError(
          (error) =>
            new EventAppendError({
              rootTaskId,
              event: placeholderEvent(rootTaskId),
              message: `Failed to read events file: ${String(error)}`,
            }),
        ),
      );

      const lines = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const events: Array<TaskEvent> = [];

      for (const line of lines) {
        const event = yield* Effect.mapError(
          decodeEvent(line),
          (error) =>
            new EventAppendError({
              rootTaskId,
              event: placeholderEvent(rootTaskId),
              message: `Failed to decode event: ${error.message}`,
            }),
        );

        events.push(event);
      }

      return events;
    });

  const listRootTaskIds = (): Effect.Effect<
    ReadonlyArray<string>,
    EventAppendError | PlatformError.PlatformError
  > =>
    Effect.gen(function* () {
      const exists = yield* fileSystem.exists(tasksDirectory);
      if (!exists) {
        return [];
      }

      const entries = yield* fileSystem.readDirectory(tasksDirectory);
      const rootTaskIds = [...new Set(entries.map((entry) => entry.split("/")[0] ?? ""))].filter(
        (entry) => entry.length > 0,
      );
      const persistedRootTaskIds: Array<string> = [];

      for (const rootTaskId of rootTaskIds) {
        const hasEventsFile = yield* fileSystem
          .exists(eventsFilePath(tasksDirectory, rootTaskId))
          .pipe(Effect.catch(() => Effect.succeed(false)));
        if (hasEventsFile) {
          persistedRootTaskIds.push(rootTaskId);
        }
      }

      return persistedRootTaskIds.sort();
    });

  const watch = (rootTaskId: string): Stream.Stream<TaskEvent> =>
    Stream.filterEffect(Stream.fromPubSub(pubSub), (event) => {
      if (event.taskId === rootTaskId) {
        return Effect.succeed(true);
      }

      const perRoot = perRootMap.get(rootTaskId);
      if (perRoot === undefined) {
        return Effect.succeed(false);
      }

      return Ref.get(perRoot.rootByTaskRef).pipe(
        Effect.map((rootByTask) => rootByTask.get(event.taskId) === rootTaskId),
      );
    });

  const watchFromFile = (
    rootTaskId: string,
  ): Stream.Stream<TaskEvent, EventAppendError | PlatformError.PlatformError> => {
    const readAppendedEvents = (
      offsetRef: Ref.Ref<number>,
    ): Effect.Effect<ReadonlyArray<TaskEvent>, EventAppendError | PlatformError.PlatformError> =>
      Effect.gen(function* () {
        const file = eventsFilePath(tasksDirectory, rootTaskId);
        const exists = yield* fileSystem.exists(file);

        if (!exists) {
          return [];
        }

        const content = yield* fileSystem.readFileString(file, "utf-8").pipe(
          Effect.mapError(
            (error) =>
              new EventAppendError({
                rootTaskId,
                event: placeholderEvent(rootTaskId),
                message: `Failed to read events file: ${String(error)}`,
              }),
          ),
        );
        const offset = yield* Ref.get(offsetRef);

        if (content.length <= offset) {
          return [];
        }

        const appended = content.slice(offset);
        const lastNewline = appended.lastIndexOf("\n");
        if (lastNewline < 0) {
          return [];
        }

        const complete = appended.slice(0, lastNewline + 1);
        const nextOffset = offset + complete.length;
        const lines = complete
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        const events: Array<TaskEvent> = [];

        for (const line of lines) {
          const event = yield* Effect.mapError(
            decodeEvent(line),
            (error) =>
              new EventAppendError({
                rootTaskId,
                event: placeholderEvent(rootTaskId),
                message: `Failed to decode event: ${error.message}`,
              }),
          );
          events.push(event);
        }

        yield* Ref.set(offsetRef, nextOffset);
        return events;
      });

    return Stream.unwrap(
      Effect.gen(function* () {
        const offsetRef = yield* Ref.make(0);
        const replay = Stream.fromIterableEffect(readAppendedEvents(offsetRef));
        const tail = Stream.fromEffectSchedule(
          readAppendedEvents(offsetRef),
          Schedule.spaced("150 millis"),
        ).pipe(Stream.flatMap((events) => Stream.fromIterable(events)));

        return Stream.concat(replay, tail);
      }),
    );
  };

  const resolveRootTaskId = (
    taskId: string,
  ): Effect.Effect<string | undefined, EventAppendError | PlatformError.PlatformError> =>
    Effect.gen(function* () {
      for (const [rootTaskId, perRoot] of perRootMap.entries()) {
        const rootByTask = yield* Ref.get(perRoot.rootByTaskRef);
        if (rootByTask.get(taskId) === rootTaskId) {
          return rootTaskId;
        }
      }

      const exists = yield* fileSystem.exists(tasksDirectory);
      if (!exists) {
        return undefined;
      }

      const rootTaskIds = yield* listRootTaskIds();

      for (const rootTaskId of rootTaskIds) {
        yield* readAndReplayEvents(rootTaskId);
        const perRoot = yield* getOrCreatePerRootState(rootTaskId);
        const rootByTask = yield* Ref.get(perRoot.rootByTaskRef);
        if (rootByTask.get(taskId) === rootTaskId) {
          return rootTaskId;
        }
      }

      return undefined;
    });

  return {
    append,
    readEvents,
    listRootTaskIds,
    watch,
    watchFromFile,
    resolveRootTaskId,
  } satisfies EventAppender;
});

export const EventAppender = Context.Service<EventAppender>("@mill/core/EventAppender");

export const EventAppenderLive = Layer.effect(EventAppender, makeEventAppender);
