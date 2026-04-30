import { expect, it } from "bun:test";
import { codex, task } from "./program.api";

it("returns a failed task actor when called outside a mill program host", async () => {
  const actor = task({
    agent: codex("openai-codex/gpt-5.3-codex"),
    prompt: "outside host",
  });

  expect(actor.getSnapshot().status).toBe("failed");
  await expect(actor.done).rejects.toMatchObject({
    _tag: "ProgramContextUnavailableError",
  });
});
