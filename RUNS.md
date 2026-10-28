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

Before execution, the worker emits `assistant.metadata` with its actual model
identifier and effective `reasoning_effort` after restoring the session and applying
its override. These display fields are saved on that run's assistant message and
included in live message snapshots. Missing metadata on historical messages is
not inferred from the host's current model selection.

Workers forward `assistant.delta` events with `turn`, `part`, and `text`. The host
appends each delta to that turn's `summary`, `thinking`, or `reply` and includes
the updated assistant message in `run.event` snapshots. Final `assistant.text`
fields replace the accumulated deltas rather than appending duplicate text.
Raw `agent.chunk` output is kept separately, not parsed into the structured reply.

`assistant.delta` and `agent.chunk` are transient stream events: they are
broadcast with the next per-run sequence number but are not stored in
`run_events`, and the in-progress transcript is checkpointed to the session at
most once per second. Other run events are stored and saved immediately; the
terminal transcript is always saved in full. After a host crash, the last
checkpoint may omit up to that interval of streamed text. Run records returned
while a run is live report its broadcast sequence, so persisted event sequence
numbers may have gaps.

If the agent fails after it has started running, the worker returns the captured
continuation state with the error, so a follow-up message continues from the same
partial history that was shown. Setup failures, and runs force-terminated after
`cancel_grace`, keep the state the run started with.

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

## Agent presets

A preset is a named, per-session adjustment applied to each isolated worker run.
Built-in presets live in `ga_harness/presets/*.toml`; user presets in
`~/.ga-harness/presets/*.toml` (same id overrides the built-in one).
Built-ins: `creative` (extend the app by writing plugins/modes); no preset is the standard
agent. User plugins are discovered from `~/.ga-harness/plugins/` (same name overrides a
built-in). Keys:
`name`, `name_zh`, `description`, `description_zh`, `prompt` (appended through
`ga-prompt`) and `disable_tools` (passed to `ga-tools.disable`). Host and
storage plugins are never touched.

- The choice is stored as `state["preset"]` of the session; `Runs.start` applies
  it to the recipe before spawning the worker. An unknown preset fails the start.
- `GET /api/state` includes `presets: {current, items, errors}` when both
  session-store and run-store are active.
- `POST /api/preset {"value": "<id>" | ""}` selects or clears the preset for the
  current session (`preset` is accepted as an alias). `POST /api/effort` now also
  accepts `value` (the key the React picker sends) besides `effort`.
- Process isolation is not a sandbox: `disable_tools` only removes tools from the
  agent; it does not restrict what the worker process may do.

## Plugin extension points

These hooks let a third-party plugin build multi-run features (for example an
agent team: a lead run that starts, messages and waits for member runs) without
patching run-store. The `runs` capability is the `Runs` service.

Host side (any plugin that injects `runs`):

- `runs.register_rpc(service, handler)` -> disposer. Serves `host.call(service, body)`
  from workers. `handler(body, call)` runs on its own thread per request, so it may
  block (start other runs, `runs.wait`, ask the UI). `call` is an `RpcCall` with
  `service`, `run_id`, `session_id`, `body` and `cancelled` (an Event set when the
  calling run finishes or is cancelled). The return value must be picklable;
  exceptions are returned to the worker as errors. A service name can be registered
  once; the built-in `plugin_control` service is registered this way.
- `runs.register_worker_plugin(name)` -> disposer. Mounts an execution plugin in
  every worker started afterwards (reference counted), in addition to
  `run-store.worker_plugins`. Host/UI/storage plugins are still refused.
- `runs.push(run_id, topic, data)` delivers a message to a live worker's
  `host.on_push` listeners; returns False if the run is not live in this host.
- `runs.wait(run_id, timeout=None)` blocks until the run is terminal or the timeout
  elapses and returns its record.
- `runs.start` raises `SessionBusy` when the session already has an active run and
  `RunLimitReached` at the parallel limit (both are `RuntimeError` subclasses, so
  existing callers are unaffected).

Worker side (an execution plugin mounted in the worker):

- `run.context` -> `{"session_id", "run_id"}`.
- `run.host` -> `WorkerHost`: `call(service, body=None, timeout=60.0)` blocks for the
  host reply and raises `RpcError` on refusal, timeout, cancellation or a broken pipe;
  `emit(name, data)` sends a `plugin.*` run event (the prefix is added when missing);
  `on_push(topic, fn)` -> disposer (topic listeners get `fn(data)`, `"*"` listeners get `fn(topic, data)`; all run on one
  dispatch thread); `cancelled` is set when the host cancels the run.

`plugin.*` run events are persisted in `run_events` and broadcast as `run.event`
like other events, but are never folded into the session transcript. Workers using
the previous `plugin` request packet still receive a `plugin_result` reply.

Status: source-reviewed and byte-compiled only; `tests/test_run_host.py` covers the
worker-side `WorkerHost` and has not been executed in this delivery.
