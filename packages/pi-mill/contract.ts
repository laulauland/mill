import { Type, type Static } from "@sinclair/typebox";
import { MillError } from "./errors.js";

export const SubagentSchema = Type.Object({
  task: Type.String({ description: "Label/description for this program run." }),
  code: Type.String({
    description:
      "TypeScript script using the `mill` global. Use mill.task() to create task actors, call .start(), then await task.done. The script runs as a top-level module — use await and Promise.all directly.",
  }),
});

export type SubagentParams = Static<typeof SubagentSchema>;

export const validateParams = (params: SubagentParams): SubagentParams | MillError => {
  if (!params.task?.trim()) {
    return new MillError({
      code: "INVALID_INPUT",
      message: "'task' is required.",
      recoverable: true,
    });
  }
  if (!params.code?.trim()) {
    return new MillError({
      code: "INVALID_INPUT",
      message: "'code' is required and must be non-empty.",
      recoverable: true,
    });
  }
  return params;
};
