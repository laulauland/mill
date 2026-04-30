import { pathToFileURL } from "../platform.adapter.js";
import { highlightCode, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { Effect } from "effect";
import { MillError, toErrorDetails } from "../errors.js";
import type { ObservabilityStore } from "../observability.js";
import {
  createMillRuntime,
  patchConsole,
  patchPromiseAll,
  prepareProgramModule,
  preflightTypecheck,
} from "../runtime.adapter.js";
import type { ExecutionResult, RunSummary } from "../types.js";

// ── Confirmation UI ────────────────────────────────────────────────────

export async function confirmExecution(
  ctx: ExtensionContext,
  code: string,
): Promise<{ approved: boolean; reason?: string }> {
  if (!ctx.hasUI) return { approved: true };

  const lines = highlightCode(code, "typescript");
  const displayLines = lines.length > 0 ? lines : code.split("\n");

  const result = await ctx.ui.custom<{ approved: boolean; reason?: string }>(
    (tui, theme, _keybindings, done) => {
      let offset = 0;
      let collectingReason = false;
      let reason = "";

      const codeRows = () => Math.max(8, Math.min(42, tui.terminal.rows - 14));
      const clamp = () => {
        offset = Math.max(0, Math.min(offset, Math.max(0, displayLines.length - codeRows())));
      };
      const boxLine = (text: string, w: number) => `│ ${truncateToWidth(text, w, "…", true)} │`;

      return {
        render(width: number) {
          clamp();
          const totalW = Math.max(40, width);
          const contentW = Math.max(20, totalW - 4);
          const rows = codeRows();
          const end = Math.min(displayLines.length, offset + rows);
          const out: string[] = [];

          out.push(`┌${"─".repeat(totalW - 2)}┐`);
          for (const l of wrapTextWithAnsi(theme.bold("Run subagent program?"), contentW))
            out.push(boxLine(l, contentW));
          for (const l of wrapTextWithAnsi(
            theme.fg("muted", `Lines ${offset + 1}-${end} / ${displayLines.length}`),
            contentW,
          ))
            out.push(boxLine(l, contentW));
          out.push(boxLine(theme.fg("dim", ""), contentW));

          for (let i = offset; i < end; i++) {
            out.push(
              boxLine(
                `${theme.fg("dim", String(i + 1).padStart(4, " "))} ${displayLines[i]}`,
                contentW,
              ),
            );
          }

          out.push(boxLine(theme.fg("dim", ""), contentW));
          if (collectingReason) {
            for (const l of wrapTextWithAnsi(
              theme.fg("warning", "Reject reason (optional):"),
              contentW,
            ))
              out.push(boxLine(l, contentW));
            for (const l of wrapTextWithAnsi(
              `${theme.fg("accent", "> ")}${reason || theme.fg("dim", "(empty)")}`,
              contentW,
            ))
              out.push(boxLine(l, contentW));
            for (const l of wrapTextWithAnsi(
              theme.fg("muted", "Enter reject • Backspace edit • Esc back"),
              contentW,
            ))
              out.push(boxLine(l, contentW));
          } else {
            for (const l of wrapTextWithAnsi(
              theme.fg("muted", "↑/↓ scroll • Enter/Y confirm • N reject • Esc cancel"),
              contentW,
            ))
              out.push(boxLine(l, contentW));
          }
          out.push(`└${"─".repeat(totalW - 2)}┘`);
          return out;
        },
        invalidate() {},
        handleInput(data: string) {
          if (collectingReason) {
            if (matchesKey(data, "return")) {
              done({ approved: false, reason: reason.trim() || undefined });
              return;
            }
            if (matchesKey(data, "escape")) {
              collectingReason = false;
              tui.requestRender();
              return;
            }
            if (matchesKey(data, "ctrl+c")) {
              done({ approved: false });
              return;
            }
            if (matchesKey(data, "backspace") || data === "\x7f") {
              reason = reason.slice(0, -1);
              tui.requestRender();
              return;
            }
            if (data.length === 1 && data >= " " && data !== "\x7f") {
              reason += data;
              tui.requestRender();
            }
            return;
          }
          if (matchesKey(data, "return") || data === "y" || data === "Y") {
            done({ approved: true });
            return;
          }
          if (data === "n" || data === "N") {
            collectingReason = true;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
            done({ approved: false });
            return;
          }
          if (matchesKey(data, "up") || data === "k") {
            offset -= 1;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "down") || data === "j") {
            offset += 1;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "pageUp")) {
            offset -= codeRows();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "pageDown")) {
            offset += codeRows();
            tui.requestRender();
          }
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%", margin: 1 },
    },
  );

  return result ?? { approved: false };
}

// ── Program execution ──────────────────────────────────────────────────

export function executeProgram(input: {
  ctx: ExtensionContext;
  runId: string;
  code: string;
  task: string;
  cwd: string;
  obs: ObservabilityStore;
  onUpdate?: (summary: RunSummary) => void;
  onChildRunSubmitted?: (runId: string, taskId: string) => void;
  signal?: AbortSignal;
  parentSessionPath?: string;
  piSessionKey?: string;
  sessionDir?: string;
  skipConfirmation?: boolean;
  millCommand?: string;
  millArgs?: string[];
  millRunsDir?: string;
}): Promise<RunSummary> {
  return Effect.runPromise(executeProgramEffect(input));
}

const executeProgramEffect = (input: {
  ctx: ExtensionContext;
  runId: string;
  code: string;
  task: string;
  cwd: string;
  obs: ObservabilityStore;
  onUpdate?: (summary: RunSummary) => void;
  onChildRunSubmitted?: (runId: string, taskId: string) => void;
  signal?: AbortSignal;
  parentSessionPath?: string;
  piSessionKey?: string;
  sessionDir?: string;
  skipConfirmation?: boolean;
  millCommand?: string;
  millArgs?: string[];
  millRunsDir?: string;
}): Effect.Effect<RunSummary> =>
  Effect.gen(function* () {
    const { ctx, runId, code, obs } = input;
    const resultsByTask = new Map<string, ExecutionResult>();
    const results: ExecutionResult[] = [];
    let runtime: ReturnType<typeof createMillRuntime> | null = null;

    const sync = () => {
      results.splice(0, results.length, ...resultsByTask.values());
    };
    const emit = (status: RunSummary["status"], error?: RunSummary["error"]) => {
      sync();
      input.onUpdate?.({
        runId,
        status,
        results: [...results],
        observability: obs.toSummary(runId),
        error,
      });
    };

    const restoreAll = (
      restoreGlobals: () => void,
      restorePromise: () => void,
      restoreConsole: () => void,
    ) =>
      Effect.sync(() => {
        restoreGlobals();
        restorePromise();
        restoreConsole();
      });

    return yield* Effect.gen(function* () {
      obs.writeArtifact(runId, "program.ts", code);

      const typeErrors = yield* Effect.promise(() => preflightTypecheck(code));
      if (typeErrors) {
        return yield* Effect.fail(
          new MillError({
            code: "INVALID_INPUT",
            message: `Type errors in program code:
${typeErrors}`,
            recoverable: true,
          }),
        );
      }

      if (!input.skipConfirmation) {
        const confirmation = yield* Effect.promise(() => confirmExecution(ctx, code));
        if (!confirmation.approved) {
          return yield* Effect.fail(
            new MillError({
              code: "CONFIRMATION_REJECTED",
              message: confirmation.reason
                ? `Cancelled: ${confirmation.reason}`
                : "Cancelled by user.",
              recoverable: true,
            }),
          );
        }
      }

      emit("running");
      obs.push(runId, "info", "program:start", { codeBytes: code.length });

      runtime = createMillRuntime(ctx, runId, obs, {
        defaultSignal: input.signal,
        onTaskUpdate: (result) => {
          resultsByTask.set(result.taskId, result);
          emit("running");
        },
        onChildRunSubmitted: input.onChildRunSubmitted,
        parentSessionPath: input.parentSessionPath,
        piSessionKey: input.piSessionKey,
        sessionDir: input.sessionDir,
        millCommand: input.millCommand,
        millArgs: input.millArgs,
        millRunsDir: input.millRunsDir,
      });

      const { modulePath } = yield* Effect.promise(() => prepareProgramModule(code));
      const restorePromise = patchPromiseAll(obs, runId);
      const restoreConsole = patchConsole(obs, runId);
      const prevMill = (globalThis as any).mill;
      const restoreGlobals = () => {
        if (prevMill === undefined) delete (globalThis as any).mill;
        else (globalThis as any).mill = prevMill;
      };
      (globalThis as any).mill = runtime;

      const importEffect = Effect.tryPromise({
        try: () => import(pathToFileURL(modulePath).toString()),
        catch: (error) => error,
      });
      const cancellationEffect = input.signal
        ? Effect.callback<never, MillError>((resume) => {
            if (input.signal?.aborted) {
              resume(
                Effect.fail(
                  new MillError({
                    code: "CANCELLED",
                    message: "Cancelled before execution.",
                    recoverable: true,
                  }),
                ),
              );
              return;
            }
            const onAbort = () =>
              resume(
                Effect.fail(
                  new MillError({ code: "CANCELLED", message: "Cancelled.", recoverable: true }),
                ),
              );
            input.signal?.addEventListener("abort", onAbort, { once: true });
            return Effect.sync(() => input.signal?.removeEventListener("abort", onAbort));
          })
        : Effect.never;

      yield* Effect.race(importEffect, cancellationEffect).pipe(
        Effect.ensuring(restoreAll(restoreGlobals, restorePromise, restoreConsole)),
      );

      emit("done");
      return {
        runId,
        status: "done" as const,
        results,
        observability: obs.toSummary(runId),
        metadata: { modulePath },
      };
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          const details = toErrorDetails(error);
          obs.push(runId, "error", details.message, { code: details.code });
          const status =
            details.code === "CANCELLED" || details.code === "CONFIRMATION_REJECTED"
              ? "cancelled"
              : "failed";
          emit(status, details);
          return { runId, status, results, observability: obs.toSummary(runId), error: details };
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          if (runtime) {
            yield* Effect.promise(() => runtime.shutdown(true)).pipe(
              Effect.catch((error) =>
                Effect.sync(() =>
                  obs.push(runId, "warning", "shutdown_failed", { error: String(error) }),
                ),
              ),
            );
          }
        }),
      ),
    );
  });
