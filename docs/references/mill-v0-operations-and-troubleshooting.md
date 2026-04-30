# mill v0 Operations & Troubleshooting

Operational conventions for diagnosing stuck runs, cancellations, and stale UI state.

## 1) Source of truth for run state

- **Canonical:** `mill status <runId> --json` and `run.json` under the run directory.
- **Advisory only:** extension-local mirrors (widget/monitor caches, historical run snapshots in pi session folders).

When in doubt, always trust canonical mill state.

## 2) Cancellation semantics

`mill cancel <runId>` performs two steps:

1. **Logical cancel**
   - Appends `run:cancelled` if needed
   - Sets run status to `cancelled`
2. **Physical cancel**
   - Reads `worker.pid`
   - Validates it belongs to `_worker --run-id <runId>`
   - Sends `SIGTERM` to worker + descendants
   - After a short grace period, sends `SIGKILL` to survivors

Cancel behavior is idempotent at run-state level. Task-level actor cancellation and ACP session cancellation exist in the core/driver layers, but full durable command propagation is still incremental.

## 3) On-disk artifacts to inspect

For run `<runId>` in runs dir `<runsDir>`:

- `<runsDir>/<runId>/run.json`
- `<runsDir>/<runId>/events.ndjson`
- `<runsDir>/<runId>/result.json`
- `<runsDir>/<runId>/worker.pid` (best effort)
- `<runsDir>/<runId>/logs/worker.log`
- `<runsDir>/<runId>/logs/cancel.log`

Some older/current driver artifacts may still use `spawnId` naming. Treat that as storage vocabulary; public authored programs use task actors.

## 4) Session behavior (ACP drivers)

The built-in ACP driver package uses `spawn-agent` internally for process/session handling. Task results include a `sessionRef` that points to the backing agent session when available.

`spawn-agent` is an internal `@mill/driver-acp` implementation detail, not a public mill API.

## 5) Fast triage checklist for "run stuck in running"

1. `mill watch --run <runId> --channel events --json`
   - if you only see a task/driver start event and no terminal event, the child driver call is still in-flight.
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
