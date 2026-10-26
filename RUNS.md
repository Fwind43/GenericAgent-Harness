# Isolated execution foundation

`run-store` provides a frontend-neutral `runs` service. Web mode loads it before
`ui-web`; CLI/TUI retain their existing single-agent execution path. This is an
execution foundation for automation plugins, not a conductor or scheduler.

## Service contract

Plugins obtain the service with `ctx.get("runs")`:

- `start(task, session_id=..., source="user", timeout=None)` reserves a durable run
  and returns its record. Pass a session ID for background work; omitting it uses
  the current UI selection only at submission time.
- `get(run_id)`, `listing(session_id=None, limit=100)` and
  `active_for(session_id)` inspect durable records.
- `events(run_id, after=0, limit=200)` reads ordered events after a sequence number.
- `cancel(run_id)` targets the owning run, independently of the selected session.
  Repeated cancellation of a cancelling or terminal run does not start another
  execution.

Sessions support explicit-ID writes through `save_for`, child-session creation
through `parent_id`, and per-session execution reservations. A live session can
only be written with its owning run ID; switching the UI must never redirect a
background result. `Workspaces.context(session_id)` resolves the pinned scope.

## Web API

- `POST /api/run`: submit `{ "task": "...", "session_id": "..." }`;
  run-store mode requires an explicit session ID and returns HTTP 202 with the run.
- `GET /api/runs?session_id=...`: list runs for a session; omit the filter to list all.
- `GET /api/runs?run_id=...`: read one run. Add `events=1&after=<seq>` to
  retrieve its persisted events after a sequence number.
- `POST /api/abort`: request cancellation of a specific run using `run_id`.
- `GET /api/events`: the existing SSE stream also carries the identified run events.

## Isolation and persistence

The host alone opens the session SQLite database. Each run starts a fresh spawned
process with its own GA runtime and a copied session/model/workspace/project
snapshot. Worker plugins are opt-in; host UI and storage plugins are excluded.
Configuration and credentials are passed to the worker in memory, not written to
run metadata. Worker failures expose the exception class, not config values or
tracebacks. Conversation and tool output are still persisted: they are not a
credential-redaction boundary.

At most one run owns a session at a time. `max_parallel` (default 4) limits total
active workers. Events `run.started`, `run.event`, `run.cancelling`, and
`run.finished` carry run/session identity and a per-run sequence number. The Web
host projects worker output into persisted messages; the React host filters by
session and sequence, and refreshes state when a run finishes. Session switching
does not cancel a worker. Model/configuration changes retain their busy guards.

Terminal states are `done`, `error`, or `aborted`. Cancellation requests cooperative
abort, then terminates only that run's own spawned process after `cancel_grace`
(default 5 seconds). Host shutdown requests cancellation. On a later host startup,
unfinished records become interrupted errors; they are not automatically retried.
A run ID is not a resumable process, durable queue, or exactly-once task guarantee.

## Boundaries

- Only one host may own a session database. Cross-host locking/coordination is not
  implemented.
- Process isolation is not a security sandbox. Workspaces are execution defaults;
  workers can still access absolute paths, the network, and shared external files.
- Parent/child session IDs establish lineage, not an orchestration policy. Planning,
  scheduling, retries, approval, result aggregation and inter-agent messaging
  belong in higher-level plugins.
- Existing legacy UI/third-party clients are not automatically multi-run-aware.
  Use the React host and explicit run/session APIs for concurrent execution.

## Delivery status

This change is source-reviewed only. Focused regression sources live in
`tests/test_runs.py`; they have not been executed as part of this delivery. No
frontend build, service restart, deployment, or live multi-worker validation was
performed.
