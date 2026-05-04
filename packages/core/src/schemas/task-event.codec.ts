import { Data, Effect } from "effect";
import * as Schema from "effect/Schema";
import { TaskEvent } from "./task-event";

export class TaskEventCodecError extends Data.TaggedError("TaskEventCodecError")<{
  readonly message: string;
}> {}

export const encodeEvent = (event: TaskEvent): string => JSON.stringify(event);

export const decodeEvent = (line: string): Effect.Effect<TaskEvent, TaskEventCodecError> =>
  Effect.try({
    try: () => Schema.decodeSync(TaskEvent)(JSON.parse(line)),
    catch: (error) =>
      new TaskEventCodecError({
        message: `Failed to decode event: ${String(error)}`,
      }),
  });
