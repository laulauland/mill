// fp extension — touches .fp/symphony/trigger whenever an issue's status
// changes. The Symphony orchestrator runs `fs.watch` on that file and reacts
// instantly instead of waiting for the next poll tick.
//
// Install by symlinking or copying this file to:
//   <fp-project>/.fp/extensions/symphony-trigger.ts
//
// The orchestrator must be started with FP_SYMPHONY_TRIGGER=watch for the
// signal file to be observed.

import type { ExtensionInit } from "@fiberplane/extensions";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const init: ExtensionInit = (fp) => {
  const triggerPath = join(fp.projectDir, ".fp", "symphony", "trigger");

  const touch = async (reason: string): Promise<void> => {
    try {
      await mkdir(dirname(triggerPath), { recursive: true });
      await writeFile(triggerPath, `${Date.now()} ${reason}\n`);
    } catch (err) {
      fp.log.warn(`failed to write trigger: ${String(err)}`);
    }
  };

  fp.on("issue:status:changed", ({ issue, from, to }) => {
    fp.log.debug(`issue ${issue.id} status ${from} -> ${to}; pinging symphony`);
    void touch(`status ${issue.id} ${from}->${to}`);
  });

  fp.on("issue:created", ({ issue }) => {
    if (issue.status === "todo") {
      fp.log.debug(`issue ${issue.id} created as todo; pinging symphony`);
      void touch(`created ${issue.id}`);
    }
  });

  fp.on("issue:updated", ({ issue }) => {
    fp.log.debug(`issue ${issue.id} updated; pinging symphony`);
    void touch(`updated ${issue.id}`);
  });
};

export default init;
