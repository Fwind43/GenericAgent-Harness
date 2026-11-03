"""Conductor mode: a session that plans and delegates instead of doing the work.

Modelled on GA Admin's Conductor. A session with conductor mode on becomes the
*parent*: its agent may only use the ``conductor_*`` tools (plus ``ask_user``,
``update_working_checkpoint`` and ``no_tool``). Each ``conductor_dispatch``
creates a child session that runs the objective as an ordinary task. The parent
collects results, inspects them, sends further instructions, reviews every
finished task (``verified`` / ``needs_work`` with a mandatory basis) and resolves
it. When a child finishes while the parent is idle, the parent is woken with a
short summary so it can continue.

Limits per parent session: 5 running, 12 unresolved, 48 in total. The conductor
may change its own running limit (1..RUNNING_CAP) with ``conductor_set_limit``;
the value is kept per parent session in ``conductor.json``.

The worker side (tool registration and tool fencing) lives in the worker-only
``conductor-worker`` plugin; it talks to this plugin through the ``conductor``
RPC service. Instructions to running children reuse ``ga-steer``.

State is written through to ``conductor.json`` beside the session database.
"""
import json
import logging
import os
import tempfile
import threading
import time
import uuid
from pathlib import Path

from ga_harness.sessions import EFFORTS

POLICY_MAX = 4000  # characters of model-selection policy text

HERE = Path(__file__).resolve().parent
log = logging.getLogger(__name__)

MAX_RUNNING = 5
MAX_OPEN = 12
MAX_TOTAL = 48
RUNNING_CAP = 8  # highest running limit a conductor may set for itself
MAX_TEXT = 20_000
RESULT_LIMIT = 4_000
WAKE_RESULT_LIMIT = 1_500  # per task in the wake-up message; full text via collect/inspect
TERMINAL = ("done", "error", "aborted", "interrupted")
VERDICTS = ("verified", "needs_work")
SOURCE = "conductor"
WAKE_COALESCE = 0.3  # seconds to gather children finishing together into one wake-up


def _store_path(sessions):
    base = getattr(sessions, "path", None)
    return Path(base).with_name("conductor.json") if base else HERE / "conductor.json"


def _message_text(message):
    if isinstance(message, str):
        return message
    if isinstance(message, dict):
        for key in ("content", "text", "message"):
            value = message.get(key)
            if isinstance(value, str):
                return value
            if isinstance(value, list):
                parts = [p.get("text", "") if isinstance(p, dict) else str(p) for p in value]
                return "\n".join(p for p in parts if p)
    return ""


def _clip(text, limit=RESULT_LIMIT):
    text = text or ""
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n...[{len(text) - limit} more chars; use conductor_inspect]"


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.data = {"enabled": {}, "tasks": {}, "limits": {}, "policies": {}, "defaults": {}}
        try:
            if self.path.is_file():
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    self.data["enabled"] = dict(loaded.get("enabled") or {})
                    self.data["tasks"] = dict(loaded.get("tasks") or {})
                    self.data["limits"] = dict(loaded.get("limits") or {})
                    self.data["defaults"] = {k: v for k, v in dict(loaded.get("defaults") or {}).items()
                                          if isinstance(v, dict) and v}
                    self.data["policies"] = {k: v for k, v in dict(loaded.get("policies") or {}).items()
                                          if isinstance(v, str) and v.strip()}
        except Exception as error:
            log.warning("conductor: could not load %s: %s", self.path, error)
        # A task that was running when the server stopped cannot be followed any more.
        for task in self.data["tasks"].values():
            if task.get("status") == "running":
                task["status"] = "interrupted"
                task["finished"] = task.get("finished") or time.time()

    def save(self):
        text = json.dumps(self.data, ensure_ascii=False, indent=1)
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".conductor-", dir=str(self.path.parent))
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(text)
            os.replace(tmp, self.path)
        except Exception as error:
            log.warning("conductor: could not save state: %s", error)


def apply(ctx, config):
    host, runs, sessions = ctx.get("web.host"), ctx.get("runs"), ctx.get("sessions")
    frontend = host.frontend
    lock = threading.RLock()
    changed = threading.Condition(lock)
    scheduled, waking = set(), set()  # parents with a pending / in-flight wake-up
    store = Store(_store_path(sessions))
    tasks, enabled, overrides = store.data["tasks"], store.data["enabled"], store.data["limits"]
    policies = store.data["policies"]  # parent -> model-selection policy text (system prompt)
    defaults = store.data["defaults"]  # parent -> {"model": name, "effort": level}; absent = inherit

    # ---- helpers ---------------------------------------------------------
    def _sid(body, key="session_id"):
        sid = body.get(key)
        if not isinstance(sid, str) or not sid:
            raise ValueError(f"{key} is required")
        return sid

    def _text(body, key, required=True, limit=MAX_TEXT):
        value = body.get(key)
        if value is None and not required:
            return ""
        if not isinstance(value, str) or (required and not value.strip()):
            raise ValueError(f"{key} is required")
        if len(value) > limit:
            raise ValueError(f"{key} is too long")
        return value.strip()

    def _owned(parent, task_id):
        task = tasks.get(task_id) if isinstance(task_id, str) else None
        if task is None or task["parent"] != parent:
            raise ValueError("task not found")
        return task

    def _children(parent):
        return sorted((t for t in tasks.values() if t["parent"] == parent), key=lambda t: t["created"])

    def _task_of_child(sid):
        for task in tasks.values():
            if task["child"] == sid:
                return task
        return None

    def _public(task, full=False):
        out = {k: task.get(k) for k in ("id", "title", "status", "review", "basis", "resolved",
                                        "child", "run_id", "created", "finished", "runs",
                                        "model", "effort")}
        out["objective"] = task["objective"] if full else _clip(task["objective"], 300)
        if task.get("status") in TERMINAL:
            out["result"] = task.get("result", "") if full else _clip(task.get("result", ""))
            if task.get("error"):
                out["error"] = task["error"]
        return out

    def _max_running(parent):
        value = (overrides.get(parent) or {}).get("running") if isinstance(parent, str) else None
        return value if isinstance(value, int) and 1 <= value <= RUNNING_CAP else MAX_RUNNING

    def _limits(parent):
        return {"running": _max_running(parent), "open": MAX_OPEN, "total": MAX_TOTAL,
                "running_cap": RUNNING_CAP}

    def _counts(parent):
        items = _children(parent)
        return {"running": sum(t["status"] == "running" for t in items),
                "open": sum(not t["resolved"] for t in items),
                "total": len(items),
                "limits": _limits(parent),
                "awaiting_review": [t["id"] for t in items
                                    if t["status"] in TERMINAL and not t["resolved"]
                                    and t.get("review") == "pending"]}

    # ---- model scheduling ----------------------------------------------
    def _catalog():
        try:
            service = ctx.get("models")
        except Exception:
            service = None
        if service is None:
            return None
        try:
            return [row for row in (service.catalog().get("items") or []) if row.get("name")]
        except Exception as error:
            log.warning("conductor: model catalog unavailable: %s", error)
            return None

    def _model_name(value):
        """Resolve a requested model to its configured name (exact name, then
        case-insensitive name, then a unique model id)."""
        if not isinstance(value, str) or not value.strip():
            raise ValueError("model must be a configured model name")
        value = value.strip()
        rows = _catalog()
        if rows is None:
            raise RuntimeError("model selection is unavailable (no model catalog)")
        names = [row["name"] for row in rows]
        if value in names:
            return value
        folded = [n for n in names if n.lower() == value.lower()]
        if len(folded) == 1:
            return folded[0]
        by_id = [row["name"] for row in rows if str(row.get("model") or "").lower() == value.lower()]
        if len(set(by_id)) == 1:
            return by_id[0]
        raise ValueError(f"unknown model {value!r}; call conductor_models for the configured names")

    def _effort(value):
        if not isinstance(value, str) or value.strip().lower() not in EFFORTS:
            raise ValueError(f"effort must be one of {', '.join(EFFORTS)}")
        return value.strip().lower()

    def _parent_selection(parent):
        """The conductor session's own model/effort (what tasks inherit)."""
        state = {}
        try:
            state = dict((sessions.get(parent, light=False) or {}).get("state") or {})
        except Exception:
            pass
        model = state.get("model")
        if not isinstance(model, str) or not model:
            backend = getattr(getattr(getattr(sessions, "agent", None), "llmclient", None), "backend", None)
            model = getattr(backend, "name", None)
        effort = state.get("effort") if "effort" in state else getattr(getattr(sessions, "agent", None),
                                                                        "gah_reasoning_effort", None)
        return (model if isinstance(model, str) and model else None,
                effort if effort in EFFORTS else None)

    def _requested(body):
        """Validated per-call model/effort overrides (None = not given)."""
        model = body.get("model")
        effort = body.get("effort")
        model = None if model in (None, "") else _model_name(model)
        effort = None if effort in (None, "") else _effort(effort)
        return model, effort

    def _selection(parent, model=None, effort=None):
        """Per-call choice > this conductor's default > the conductor's own selection.
        The policy is prose for the conductor's prompt; it never picks a model itself."""
        with lock:
            default = dict(defaults.get(parent) or {})
        own_model, own_effort = _parent_selection(parent)
        return (model or default.get("model") or own_model,
                effort or default.get("effort") or own_effort)

    def _apply_selection(task, model, effort):
        values = {}
        if model:
            values["model"] = model
        if effort:
            values["effort"] = effort
        if values:
            sessions.remember_for(task["child"], **values)
            task.update(values)

    def _publish():
        with lock:
            store.save()
            changed.notify_all()
        try:
            frontend.broadcast("snapshot", frontend.snapshot())
        except Exception:
            pass

    def _start(task, text):
        record = runs.start(text, session_id=task["child"], source=SOURCE)
        task.update(status="running", run_id=record["id"], finished=None, review="pending",
                    basis="", resolved=False, acked=False, notified=False, error="")
        task["runs"] = task.get("runs", 0) + 1

    # ---- operations (shared by the RPC service and the web routes) -------
    def role(body):
        sid = _sid(body)
        with lock:
            if enabled.get(sid):
                return {"role": "parent", **_counts(sid), "policy": policies.get(sid)}
            task = _task_of_child(sid)
            if task is not None:
                return {"role": "worker", "task_id": task["id"], "parent": task["parent"]}
        return {"role": "none"}

    def dispatch(body):
        parent = _sid(body)
        objective = _text(body, "objective")
        title = _text(body, "title", required=False, limit=100) or objective.splitlines()[0][:60]
        model, effort = _requested(body)
        failed = None
        with lock:
            counts = _counts(parent)
            if counts["total"] >= MAX_TOTAL:
                raise RuntimeError(f"task limit reached ({MAX_TOTAL} per conductor session)")
            if counts["open"] >= MAX_OPEN:
                raise RuntimeError(f"{MAX_OPEN} tasks are unresolved; review and resolve some first")
            if counts["running"] >= _max_running(parent):
                raise RuntimeError(f"{_max_running(parent)} tasks are already running (the running limit); end your turn and "
                                   "dispatch more after you are woken by a finished task")
            child = sessions.create(parent_id=parent, title=title)
            task = {"id": "t" + uuid.uuid4().hex[:8], "parent": parent, "child": child["id"],
                    "title": title, "objective": objective, "created": time.time(), "runs": 0}
            tasks[task["id"]] = task
            try:
                _apply_selection(task, *_selection(parent, model, effort))
                _start(task, objective)
            except Exception as error:
                failed = error
                task.update(status="error", error=str(error), finished=time.time(), result="",
                            review="pending", basis="", resolved=False, acked=True, notified=True)
        _publish()
        if failed is not None:
            raise RuntimeError(f"task {task['id']} could not be started: {failed}")
        return {"task": _public(task), **_counts(parent)}

    def collect(body):
        """Return finished, not yet collected tasks. Never blocks: the parent is
        woken by ``run.finished`` instead of waiting inside a turn."""
        parent = _sid(body)
        with lock:
            children = _children(parent)
            ready = [t for t in children if t["status"] in TERMINAL and not t.get("acked")]
            for task in ready:
                task["acked"] = task["notified"] = True
            result = {"finished": [_public(t) for t in ready],
                      "running": [_public(t) for t in _children(parent) if t["status"] == "running"],
                      **_counts(parent)}
        if ready:
            _publish()
        return result

    def tasks_op(body):
        parent = _sid(body)
        with lock:
            return {"tasks": [_public(t) for t in _children(parent)], **_counts(parent)}

    def inspect(body):
        parent = _sid(body)
        with lock:
            task = _owned(parent, body.get("task_id"))
            out = _public(task, full=True)
        try:
            out["recent_runs"] = [{k: r.get(k) for k in ("id", "status", "source", "created")}
                                  for r in runs.listing(task["child"], limit=5)]
        except Exception:
            pass
        return {"task": out}

    def instruct(body):
        parent = _sid(body)
        text = _text(body, "instruction")
        model, effort = _requested(body)
        with lock:
            task = _owned(parent, body.get("task_id"))
            out = _instruct(parent, task, text, model, effort)
        _publish()
        return out

    def _instruct(parent, task, text, model=None, effort=None):
        # Caller holds the lock and publishes.
        if task["resolved"]:
            raise RuntimeError("task is resolved; dispatch a new task instead")
        if task["status"] == "running":
            if model or effort:
                raise RuntimeError("the task is running; its model can only change for a follow-up run "
                                   "after it finishes (or cancel it first)")
            try:
                ok = runs.push(task["run_id"], "steer", {"id": "c" + uuid.uuid4().hex[:10], "text": text})
            except Exception:
                ok = False
            if ok:
                return {"delivered": "steered into the running task at its next turn boundary"}
            raise RuntimeError("the running task could not take the instruction; retry after it finishes")
        if sum(t["status"] == "running" for t in _children(parent)) >= _max_running(parent):
            raise RuntimeError(f"{_max_running(parent)} tasks are already running; send this "
                               "instruction after you are woken by a finished task")
        _apply_selection(task, model, effort)
        _start(task, text)
        return {"delivered": "started a follow-up run in the task session", "task": _public(task)}

    def cancel(body):
        parent = _sid(body)
        with lock:
            task = _owned(parent, body.get("task_id"))
            run_id = task.get("run_id") if task["status"] == "running" else None
        if run_id:
            runs.cancel(run_id)
        return {"task": _public(task), "cancelling": bool(run_id)}

    def _task_ids(body):
        ids = body.get("task_ids")
        if ids is None:
            ids = [body.get("task_id")]
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i for i in ids):
            raise ValueError("task_id or a non-empty task_ids list is required")
        return list(dict.fromkeys(ids))

    def _close(task):
        if task["status"] not in TERMINAL:
            raise RuntimeError("task is still running")
        if task.get("review") == "pending":
            raise RuntimeError("review the task first (conductor_review with a basis)")
        if task["status"] == "done" and task.get("review") != "verified":
            raise RuntimeError("a finished task must be reviewed as 'verified' before resolving "
                               "(or continue it with needs_work + instruction)")
        task["resolved"] = task["acked"] = task["notified"] = True

    def review(body):
        """Record one verdict for one or more finished tasks. Optional follow-ups in the
        same call: ``resolve`` closes them, ``instruction`` (needs_work only) continues them."""
        parent = _sid(body)
        verdict = body.get("verdict")
        if verdict not in VERDICTS:
            raise ValueError("verdict must be 'verified' or 'needs_work'")
        basis = _text(body, "basis", limit=4000)
        ids = _task_ids(body)
        close = body.get("resolve") is True
        instruction = _text(body, "instruction", required=False)
        if instruction and verdict != "needs_work":
            raise ValueError("instruction is only allowed with verdict 'needs_work'")
        if close and instruction:
            raise ValueError("a task cannot be resolved and continued at once")
        results = []
        with lock:
            owned = [_owned(parent, i) for i in ids]
            for task in owned:
                if task["status"] not in TERMINAL:
                    raise RuntimeError(f"task {task['id']} is still running; review it after it finishes")
                if task["resolved"]:
                    raise RuntimeError(f"task {task['id']} is already resolved")
            for task in owned:
                task["review"], task["basis"] = verdict, basis
                task["acked"] = task["notified"] = True
                item = {"id": task["id"], "review": verdict}
                try:
                    if close:
                        _close(task)
                        item["resolved"] = True
                    elif instruction:
                        item["delivered"] = _instruct(parent, task, instruction)["delivered"]
                except Exception as error:
                    item["error"] = str(error)
                item["status"] = task["status"]
                results.append(item)
            counts = _counts(parent)
        _publish()
        return {"reviewed": results, **counts}

    def resolve(body):
        parent = _sid(body)
        ids = _task_ids(body)
        with lock:
            owned = [_owned(parent, i) for i in ids]
            for task in owned:
                try:
                    _close(task)
                except RuntimeError as error:
                    raise RuntimeError(f"task {task['id']}: {error}") from None
            counts = _counts(parent)
        _publish()
        return {"resolved": [t["id"] for t in owned], **counts}

    def toggle(body):
        sid = _sid(body)
        on = body.get("enabled")
        if not isinstance(on, bool):
            raise ValueError("enabled must be a boolean")
        with lock:
            if on and _task_of_child(sid) is not None:
                raise RuntimeError("a conductor task session cannot become a conductor")
            if on:
                enabled[sid] = True
            else:
                enabled.pop(sid, None)
        _publish()
        return {"enabled": on}

    def set_limit(body):
        """Change this conductor session's own running (concurrency) limit. Lowering it
        never stops running tasks; it only blocks new starts until fewer are running."""
        parent = _sid(body)
        value = body.get("running")
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= RUNNING_CAP:
            raise ValueError(f"running must be an integer from 1 to {RUNNING_CAP}")
        with lock:
            previous = _max_running(parent)
            if value == MAX_RUNNING:
                overrides.pop(parent, None)
            else:
                overrides[parent] = {"running": value}
            counts = _counts(parent)
        _publish()
        out = {"previous": previous, **counts}
        if counts["running"] > value:
            out["note"] = (f"{counts['running']} tasks are running, above the new limit; they keep "
                           "running and no new task starts until fewer than the limit are running")
        return out

    def models_op(body):
        """Configured models, the conductor's own selection and its model policy."""
        parent = _sid(body)
        rows = _catalog()
        own_model, own_effort = _parent_selection(parent)
        with lock:
            policy = policies.get(parent)
            default = dict(defaults.get(parent) or {})
        model, effort = _selection(parent)
        return {"models": [{"name": r["name"], "model": r.get("model"), "provider": r.get("provider")}
                           for r in rows] if rows is not None else None,
                "efforts": list(EFFORTS),
                "conductor": {"model": own_model, "effort": own_effort},
                "default": {"model": default.get("model"), "effort": default.get("effort")},
                "effective_default": {"model": model, "effort": effort},
                "policy": policy}

    def set_policy(body):
        """Set this conductor's model-selection policy: free text added to its system
        prompt (which models/efforts to use for which kinds of task). Empty clears it."""
        parent = _sid(body)
        text = body.get("policy")
        if text is not None and not isinstance(text, str):
            raise ValueError("policy must be text")
        text = (text or "").strip()
        if len(text) > POLICY_MAX:
            raise ValueError(f"policy is too long ({len(text)} > {POLICY_MAX} characters)")
        with lock:
            previous = policies.get(parent)
            if text:
                policies[parent] = text
            else:
                policies.pop(parent, None)
        _publish()
        return {"previous": previous, "policy": text or None,
                "note": "added to your system prompt from your next turn on; follow it from now"
                        if text else "policy cleared"}

    def set_default(body):
        """Set this conductor's default model/effort for new tasks. "inherit" (or null)
        for a field clears it so tasks follow the conductor's own choice again."""
        parent = _sid(body)
        if "model" not in body and "effort" not in body:
            raise ValueError("give model and/or effort")
        updates = {}
        for key, check in (("model", _model_name), ("effort", _effort)):
            if key not in body:
                continue
            value = body.get(key)
            if value is None or (isinstance(value, str) and value.strip().lower() in ("", "inherit", "default")):
                updates[key] = None
            else:
                updates[key] = check(value)
        with lock:
            previous = dict(defaults.get(parent) or {})
            default = dict(previous)
            for key, value in updates.items():
                if value is None:
                    default.pop(key, None)
                else:
                    default[key] = value
            if default:
                defaults[parent] = default
            else:
                defaults.pop(parent, None)
        _publish()
        out = models_op({"session_id": parent})
        out.pop("models", None)
        out["previous"] = {"model": previous.get("model"), "effort": previous.get("effort")}
        out["note"] = "applies to tasks dispatched from now on; running tasks keep their model"
        return out

    OPS = {"set_default": set_default, "set_limit": set_limit, "models": models_op, "set_policy": set_policy, "dispatch": dispatch, "collect": collect, "tasks": tasks_op, "inspect": inspect,
           "instruct": instruct, "cancel": cancel, "review": review, "resolve": resolve}

    def _require_parent(body):
        with lock:
            if not enabled.get(body.get("session_id")):
                raise RuntimeError("conductor mode is off for this session")

    def rpc(body, call=None):
        body = body if isinstance(body, dict) else {}
        name = body.get("op")
        if name == "role":
            return role(body)
        op = OPS.get(name)
        if op is None:
            raise ValueError("unknown conductor operation")
        _require_parent(body)
        return op(body)

    # ---- wake the parent when children finish ----------------------------
    def _schedule_wake(parent):
        # Children that finish close together are reported in one wake-up: the
        # first finish opens a short window, later ones join the same message.
        with lock:
            if parent in scheduled:
                return
            scheduled.add(parent)

        def fire():
            with lock:
                scheduled.discard(parent)
            _wake(parent)
        timer = threading.Timer(WAKE_COALESCE, fire)
        timer.name, timer.daemon = "conductor-wake", True
        timer.start()

    def _wake(parent):
        with lock:
            if not enabled.get(parent) or parent in waking:
                return
            pending = [t for t in _children(parent)
                       if t["status"] in TERMINAL and not t.get("acked") and not t.get("notified")]
            if not pending or runs.active_for(parent):
                return
            # One queue in arrival order (as GA's conductor inbox): a user message
            # queued before these finished goes first; its run's end wakes us again.
            peek = ctx.get("run_queue.peek")
            queued = peek(parent) if callable(peek) else None
            if queued is not None and queued < min(t.get("finished") or 0 for t in pending):
                return
            for task in pending:
                task["notified"] = task["acked"] = True  # results travel in this message
            waking.add(parent)  # until the run is registered, so no second wake races in
            # The "- id \u00b7 title \u00b7 status" lines and "N task(s) still running" are
            # parsed by the web UI (ChatMessage.tsx); keep their format.
            lines = [f"- {t['id']} \u00b7 {t['title']} \u00b7 {t['status']}" for t in pending]
            still = sum(t["status"] == "running" for t in _children(parent))
            other = [i for i in _counts(parent)["awaiting_review"] if i not in {t["id"] for t in pending}]
            details = []
            for t in pending:
                body = _clip(t.get("result", ""), WAKE_RESULT_LIMIT).strip() or "(no result text)"
                if t.get("error"):
                    body = f"error: {t['error']}\n{body}"
                # Quote the body so result text can never look like a task line to the UI.
                details.append(f"=== {t['id']} result ===\n" + "\n".join("> " + x for x in body.splitlines()))
        text = ("[Conductor] Delegated task(s) finished:\n" + "\n".join(lines)
                + f"\n{still} task(s) still running."
                + (f" Also awaiting review from earlier: {', '.join(other)}." if other else "")
                + "\n\n" + "\n\n".join(details)
                + "\n\nReview these in this turn with conductor_review (task_ids for several at once; "
                  "resolve=true to close verified ones, or needs_work + instruction to continue). "
                  "Use conductor_inspect only if a clipped result is not enough.")
        try:
            code, reply = frontend.submit(text, session_id=parent, source=SOURCE)
            if code >= 400:
                raise RuntimeError((reply or {}).get("error") or "run could not be started")
        except Exception as error:
            log.warning("conductor: could not wake %s: %s", parent, error)
            with lock:
                for task in pending:
                    task["notified"] = task["acked"] = False
        finally:
            with lock:
                waking.discard(parent)
        _publish()

    def pending_since(parent):
        """Finish time of the oldest unreported child, else None (read by run-queue)."""
        with lock:
            if not enabled.get(parent):
                return None
            times = [t.get("finished") or 0 for t in _children(parent)
                     if t["status"] in TERMINAL and not t.get("acked") and not t.get("notified")]
            return min(times) if times else None

    def on_finished(data, nxt=None):
        try:
            sid, run_id = data.get("session_id"), data.get("run_id")
            record = data.get("run") or {}
            parent = None
            with lock:
                task = _task_of_child(sid) if sid else None
                if task is not None and task.get("run_id") == run_id and task["status"] == "running":
                    status = record.get("status") or "done"
                    task["status"] = status if status in TERMINAL else "done"
                    task["finished"] = time.time()
                    task["result"] = _message_text(data.get("message"))
                    task["error"] = record.get("error") or ""
                    task["acked"] = task["notified"] = False
                    parent = task["parent"]
                    store.save()
                    changed.notify_all()
                elif sid and enabled.get(sid):
                    parent = sid  # the parent went idle: deliver anything that finished meanwhile
            if parent:
                _schedule_wake(parent)
        except Exception as error:
            log.warning("conductor: run.finished handling failed: %s", error)
        return nxt(data) if nxt else None

    def snapshot(data, nxt=None):
        try:
            current = data.get("session_id")
            with lock:
                data["conductor"] = {
                    "enabled": sorted(enabled),
                    "tasks": [_public(t) for t in sorted(tasks.values(), key=lambda t: t["created"])
                              if enabled.get(t["parent"]) or not t["resolved"]],
                    "children": {t["child"]: {"task_id": t["id"], "parent": t["parent"]} for t in tasks.values()},
                    "limits": _limits(current),
                    "current": current}
        except Exception:
            pass
        return nxt(data) if nxt else data

    def _route(fn, guard=True):
        def route(request):
            body = request.get("body") or {}
            try:
                if guard:
                    _require_parent(body)
                result = fn(body)
            except ValueError as error:
                return 400, {"error": str(error)}
            except RuntimeError as error:
                return 409, {"error": str(error)}
            return 200, {"ok": True, **(result or {})}
        return route

    ctx.scope.add(runs.register_rpc("conductor", rpc))
    ctx.scope.add(runs.register_worker_plugin("conductor-worker"))
    ctx.scope.add(runs.register_worker_plugin("ga-steer"))
    ctx.on("web.snapshot", snapshot)
    ctx.provide("conductor.pending_since", pending_since)
    ctx.on("run.finished", on_finished)
    script, style = HERE / "client.js", HERE / "client.css"
    ctx.scope.add(host.register("conductor", script=script if script.is_file() else None,
                                style=style if style.is_file() else None, order=36,
                                routes={("POST", "toggle"): _route(toggle, guard=False),
                                        ("POST", "cancel"): _route(cancel),
                                        ("POST", "resolve"): _route(resolve)}))
