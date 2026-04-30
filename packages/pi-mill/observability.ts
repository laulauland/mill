import {
  ensureDirectory,
  makeTemporaryDirectory,
  path,
  provideFileSystem,
  temporaryDirectory,
  writeTextFile,
} from "./platform.adapter.js";
import { Effect, Exit } from "effect";
import { now } from "./clock.js";

export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface RunEvent {
  time: number;
  type: "status" | "info" | "warning" | "error" | "artifact";
  message: string;
  data?: Record<string, unknown>;
}

export interface RunRecord {
  runId: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  events: RunEvent[];
  artifactsDir?: string;
  artifacts: string[];
}

export class ObservabilityStore {
  private readonly runs = new Map<string, RunRecord>();

  createRun(runId: string, withArtifacts: boolean, _sessionDir?: string): RunRecord {
    const record: RunRecord = {
      runId,
      status: "queued",
      startedAt: now(),
      events: [],
      artifacts: [],
    };

    if (withArtifacts) {
      const created = Effect.runSyncExit(
        provideFileSystem(
          makeTemporaryDirectory(path.join(temporaryDirectory(), "pi-subagent-observe-")),
        ),
      );
      if (Exit.isSuccess(created)) {
        const base = created.value;
        const ensured = Effect.runSyncExit(provideFileSystem(ensureDirectory(base)));
        if (Exit.isSuccess(ensured)) {
          record.artifactsDir = base;
        } else {
          console.warn(`Unable to create pi-mill artifacts directory ${base}.`);
        }
      } else {
        console.warn("Unable to create pi-mill artifacts directory.");
      }
    }

    this.runs.set(runId, record);
    return record;
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  setStatus(runId: string, status: RunStatus, message?: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = status;
    if (status === "done" || status === "failed" || status === "cancelled") run.endedAt = now();
    if (message) this.push(runId, "status", message, { status });
  }

  push(
    runId: string,
    type: RunEvent["type"],
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.events.push({ time: now(), type, message, data });
  }

  writeArtifact(runId: string, relativePath: string, content: string): string | null {
    const run = this.runs.get(runId);
    if (!run || !run.artifactsDir) return null;
    const fullPath = path.join(run.artifactsDir, relativePath);
    const written = Effect.runSyncExit(
      provideFileSystem(
        Effect.gen(function* () {
          yield* ensureDirectory(path.dirname(fullPath));
          yield* writeTextFile(fullPath, content);
        }),
      ),
    );
    if (Exit.isFailure(written)) {
      console.warn(`Unable to write pi-mill artifact ${fullPath}.`);
      return null;
    }
    run.artifacts.push(fullPath);
    this.push(runId, "artifact", `artifact:${relativePath}`, { path: fullPath });
    return fullPath;
  }

  toSummary(
    runId: string,
  ): Pick<
    RunRecord,
    "runId" | "status" | "startedAt" | "endedAt" | "events" | "artifacts" | "artifactsDir"
  > | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      runId: run.runId,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      events: run.events,
      artifacts: run.artifacts,
      artifactsDir: run.artifactsDir,
    };
  }
}
