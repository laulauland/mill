import { Type, type Static } from "@sinclair/typebox";
import { MillError } from "./errors.js";

export const SubagentSchema = Type.Object({
  task: Type.String({ description: "Label/description for this program run." }),
  code: Type.String({
    description:
      "TypeScript script using the `mill` global. Use mill.spawn() to orchestrate agents. The script runs as a top-level module — use await and Promise.all directly.",
  }),
});

export type SubagentParams = Static<typeof SubagentSchema>;

export function validateParams(params: SubagentParams): SubagentParams {
  if (!params.task?.trim()) {
    throw new MillError({
      code: "INVALID_INPUT",
      message: "'task' is required.",
      recoverable: true,
    });
  }
  if (!params.code?.trim()) {
    throw new MillError({
      code: "INVALID_INPUT",
      message: "'code' is required and must be non-empty.",
      recoverable: true,
    });
  }
  return params;
}
