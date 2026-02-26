# mill v0 Operations & Troubleshooting

Operational conventions for diagnosing stuck runs, cancellations, and stale UI state.

## 1) Source of truth for run state

- **Canonical:** `mill status <runId> --json` and `run.json` under the run directory.
- **Advisory only:** extension-local mirrors (widget/monitor caches, historical `run.json` snapshots in pi session folders).

When in doubt, always trust canonical mill state.

## 2) Cancellation semantics

`mill cancel <runId>` performs two steps:

1. **Logical cancel**
   - Appends `run:cancelled` (if needed)
   - Sets run status to `cancelled`
2. **Physical cancel**
   - Reads `worker.pid`
   - Validates it belongs to `_worker --run-id <runId>`
   - Sends `SIGTERM` to worker + descendants
   - After a short grace period, sends `SIGKILL` to survivors

Cancel behavior is idempotent at run-state level.

## 3) On-disk artifacts to inspect

For run `<runId>` in runs dir `<runsDir>`:

- `<runsDir>/<runId>/run.json`
- `<runsDir>/<runId>/events.ndjson`
- `<runsDir>/<runId>/result.json`
- `<runsDir>/<runId>/worker.pid` (best effort)
- `<runsDir>/<runId>/logs/worker.log`
- `<runsDir>/<runId>/logs/cancel.log`
- `<runsDir>/<runId>/sessions/<spawnId>.jsonl` (pi driver transcripts)

## 4) Session behavior (pi driver)

pi driver uses explicit per-spawn session files:

- `--session <runDir>/sessions/<spawnId>.jsonl`
- `sessionRef` in spawn result points to that file path

This keeps transcripts available for post-hoc debugging and parent-orchestrator context recovery.

## 5) Fast triage checklist for "run stuck in running"

1. `mill watch --run <runId> --channel events --json`
   - if you only see `spawn:start` and no `spawn:complete`, the child driver call is still in-flight.
2. Check process liveness using `worker.pid` + OS process list.
3. `mill cancel <runId> --json`
4. Read `logs/cancel.log`
   - verify TERM/KILL steps and survivor count.
5. Re-check `mill status <runId> --json`

## 6) Stale historical entries in pi monitor

Convention:

- Historical `status: running` entries are reconciled against canonical `mill status` on scan.
- If canonical status is terminal, scanner rewrites the historical record with reconciled terminal status.

This avoids long-lived "running" ghosts from previous failures.
