"""Conductor mode: a session that plans and delegates instead of doing the work.

Modelled on GA Admin's Conductor. A session with conductor mode on becomes the
*parent*: its agent may only use the ``conductor_*`` tools (plus ``ask_user``,
``update_working_checkpoint`` and ``no_tool``). Each ``conductor_dispatch``
creates a child session that runs the objective as an ordinary task. The parent
collects results, inspects them, sends further instructions, reviews every
finished task (``verified`` / ``needs_work`` with a mandatory basis) and resolves
it. When a child finishes while the parent is idle, the parent is woken with a
short summary so it can continue.

Limits per parent session: 3 running, 12 unresolved, 48 in total.

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

HERE = Path(__file__).resolve().parent
log = logging.getLogger(__name__)

MAX_RUNNING = 3
MAX_OPEN = 12
MAX_TOTAL = 48
MAX_TEXT = 20_000
RESULT_LIMIT = 4_000
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
        self.data = {"enabled": {}, "tasks": {}}
        try:
            if self.path.is_file():
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    self.data["enabled"] = dict(loaded.get("enabled") or {})
                    self.data["tasks"] = dict(loaded.get("tasks") or {})
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
    tasks, enabled = store.data["tasks"], store.data["enabled"]

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
                                        "child", "run_id", "created", "finished", "runs")}
        out["objective"] = task["objective"] if full else _clip(task["objective"], 300)
        if task.get("status") in TERMINAL:
            out["result"] = task.get("result", "") if full else _clip(task.get("result", ""))
            if task.get("error"):
                out["error"] = task["error"]
        return out

    def _counts(parent):
        items = _children(parent)
        return {"running": sum(t["status"] == "running" for t in items),
                "open": sum(not t["resolved"] for t in items),
                "total": len(items),
                "limits": {"running": MAX_RUNNING, "open": MAX_OPEN, "total": MAX_TOTAL}}

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
                return {"role": "parent", **_counts(sid)}
            task = _task_of_child(sid)
            if task is not None:
                return {"role": "worker", "task_id": task["id"], "parent": task["parent"]}
        return {"role": "none"}

    def dispatch(body):
        parent = _sid(body)
        objective = _text(body, "objective")
        title = _text(body, "title", required=False, limit=100) or objective.splitlines()[0][:60]
        failed = None
        with lock:
            counts = _counts(parent)
            if counts["total"] >= MAX_TOTAL:
                raise RuntimeError(f"task limit reached ({MAX_TOTAL} per conductor session)")
            if counts["open"] >= MAX_OPEN:
                raise RuntimeError(f"{MAX_OPEN} tasks are unresolved; review and resolve some first")
            if counts["running"] >= MAX_RUNNING:
                raise RuntimeError(f"{MAX_RUNNING} tasks are already running; collect results first")
            child = sessions.create(parent_id=parent, title="\u25b8 " + title)
            task = {"id": "t" + uuid.uuid4().hex[:8], "parent": parent, "child": child["id"],
                    "title": title, "objective": objective, "created": time.time(), "runs": 0}
            tasks[task["id"]] = task
            try:
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
        with lock:
            task = _owned(parent, body.get("task_id"))
            if task["resolved"]:
                raise RuntimeError("task is resolved; dispatch a new task instead")
            if task["status"] == "running":
                try:
                    ok = runs.push(task["run_id"], "steer", {"id": "c" + uuid.uuid4().hex[:10], "text": text})
                except Exception:
                    ok = False
                if ok:
                    return {"delivered": "steered into the running task at its next turn boundary"}
                raise RuntimeError("the running task could not take the instruction; retry after it finishes")
            if sum(t["status"] == "running" for t in _children(parent)) >= MAX_RUNNING:
                raise RuntimeError(f"{MAX_RUNNING} tasks are already running")
            _start(task, text)
        _publish()
        return {"delivered": "started a follow-up run in the task session", "task": _public(task)}

    def cancel(body):
        parent = _sid(body)
        with lock:
            task = _owned(parent, body.get("task_id"))
            run_id = task.get("run_id") if task["status"] == "running" else None
        if run_id:
            runs.cancel(run_id)
        return {"task": _public(task), "cancelling": bool(run_id)}

    def review(body):
        parent = _sid(body)
        verdict = body.get("verdict")
        if verdict not in VERDICTS:
            raise ValueError("verdict must be 'verified' or 'needs_work'")
        basis = _text(body, "basis", limit=4000)
        with lock:
            task = _owned(parent, body.get("task_id"))
            if task["status"] not in TERMINAL:
                raise RuntimeError("task is still running; review it after it finishes")
            task["review"], task["basis"] = verdict, basis
            task["acked"] = task["notified"] = True
        _publish()
        return {"task": _public(task)}

    def resolve(body):
        parent = _sid(body)
        with lock:
            task = _owned(parent, body.get("task_id"))
            if task["status"] not in TERMINAL:
                raise RuntimeError("task is still running")
            if task["status"] == "done" and task.get("review") != "verified":
                raise RuntimeError("review the task as 'verified' before resolving it "
                                   "(or send needs_work instructions)")
            task["resolved"] = task["acked"] = task["notified"] = True
        _publish()
        return {"task": _public(task), **_counts(parent)}

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

    OPS = {"dispatch": dispatch, "collect": collect, "tasks": tasks_op, "inspect": inspect,
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
                task["notified"] = True
            waking.add(parent)  # until the run is registered, so no second wake races in
            lines = [f"- {t['id']} \u00b7 {t['title']} \u00b7 {t['status']}" for t in pending]
            still = sum(t["status"] == "running" for t in _children(parent))
        text = ("[Conductor] Delegated task(s) finished:\n" + "\n".join(lines)
                + f"\n{still} task(s) still running. Call conductor_collect to read the results, "
                  "then review (verified / needs_work with a basis) and resolve each task.")
        try:
            code, reply = frontend.submit(text, session_id=parent, source=SOURCE)
            if code >= 400:
                raise RuntimeError((reply or {}).get("error") or "run could not be started")
        except Exception as error:
            log.warning("conductor: could not wake %s: %s", parent, error)
            with lock:
                for task in pending:
                    task["notified"] = False
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
                    "limits": {"running": MAX_RUNNING, "open": MAX_OPEN, "total": MAX_TOTAL},
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
