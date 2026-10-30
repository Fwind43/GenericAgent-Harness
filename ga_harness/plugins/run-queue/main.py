"""Run queue: messages sent while a session is busy wait here.

Queued items can be edited or cancelled. "Steer" hands an item to the running
worker (via the ``ga-steer`` worker plugin), which injects it at the next turn
boundary instead of interrupting the task. When a run finishes, the next queued
item of that session is submitted as an ordinary user message.

The queue lives on the server and is written through to ``run-queue.db`` beside
the session database, so it survives page reloads and server restarts. Items that
were being steered when the server stopped come back as plain queued items.
"""
import logging
import sqlite3
import threading
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
log = logging.getLogger(__name__)
MAX_TEXT = 100_000


class Store:
    """Persistent copy of every session's queue (order kept by ``pos``)."""

    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()
        with self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS queue(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, "
                       "pos INTEGER NOT NULL, text TEXT NOT NULL, created REAL NOT NULL)")

    def _db(self):
        return sqlite3.connect(self.path, timeout=10)

    def load(self):
        queues = {}
        with self.lock, self._db() as db:
            for item_id, sid, text, created in db.execute(
                    "SELECT id, session_id, text, created FROM queue ORDER BY session_id, pos"):
                queues.setdefault(sid, []).append(
                    {"id": item_id, "text": text, "state": "queued", "created": created})
        return queues

    def save(self, queues):
        rows = [(i["id"], sid, pos, i["text"], i.get("created") or time.time())
                for sid, items in queues.items() for pos, i in enumerate(items)]
        with self.lock, self._db() as db:  # one transaction: replace the whole (small) table
            db.execute("DELETE FROM queue")
            db.executemany("INSERT INTO queue(id, session_id, pos, text, created) VALUES(?,?,?,?,?)", rows)


def _store_path(sessions):
    base = getattr(sessions, "path", None) or getattr(sessions, "db_path", None)
    return Path(base).with_name("run-queue.db") if base else HERE / "run-queue.db"


def apply(ctx, config):
    host, runs, sessions = ctx.get("web.host"), ctx.get("runs"), ctx.get("sessions")
    frontend = host.frontend
    lock = threading.RLock()
    store = Store(_store_path(sessions))
    # session_id -> [{"id", "text", "created", "state": "queued" | "steering", "run_id"?}]
    queues = store.load()
    held = set()  # sessions whose queue stopped after an aborted run

    def peek(sid):
        """Creation time of the message that will be sent next on its own, else None."""
        with lock:
            items = queues.get(sid) or []
            if sid in held or not items or items[0]["state"] != "queued":
                return None
            return items[0].get("created") or 0

    def _items(sid):
        return queues.setdefault(sid, [])

    def _find(sid, item_id):
        for item in queues.get(sid, []):
            if item["id"] == item_id:
                return item
        raise ValueError("queue item not found")

    def _public(sid):
        with lock:
            return [{"id": i["id"], "text": i["text"], "state": i["state"]} for i in queues.get(sid, [])]

    def _persist():
        with lock:
            snapshot_ = {sid: [dict(i) for i in items] for sid, items in queues.items() if items}
            for sid in [sid for sid, items in queues.items() if not items]:
                del queues[sid]
        try:
            store.save(snapshot_)
        except Exception as error:  # keep serving from memory; report instead of failing the request
            log.warning("run-queue: could not save queue: %s", error)

    def _publish():
        _persist()
        try:
            frontend.broadcast("snapshot", frontend.snapshot())
        except Exception:
            pass

    def _text(body):
        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("text is required")
        if len(text) > MAX_TEXT:
            raise ValueError("text is too long")
        return text

    def _sid(body):
        sid = body.get("session_id")
        if not isinstance(sid, str) or not sid:
            raise ValueError("session_id is required")
        return sid

    def snapshot(data, nxt=None):
        try:
            sid = data.get("session_id")
            if sid:
                data["queue"] = _public(sid)
        except Exception:
            pass
        return nxt(data) if nxt else data

    def _route(fn):
        def route(request):
            try:
                result = fn(request.get("body") or {})
            except ValueError as error:
                return 400, {"error": str(error)}
            except RuntimeError as error:
                return 409, {"error": str(error)}
            _publish()
            return 200, {"ok": True, **(result or {})}
        return route

    def add(body):
        sid, text = _sid(body), _text(body)
        if runs is None or not runs.active_for(sid):
            # Nothing is running: send right away instead of queueing.
            code, reply = frontend.submit(text, session_id=sid, source="user")
            if code >= 400:
                raise RuntimeError(reply.get("error") or "run could not be started")
            return {"sent": True}
        item = {"id": uuid.uuid4().hex[:12], "text": text, "state": "queued", "created": time.time()}
        with lock:
            _items(sid).append(item)
        return {"item": {"id": item["id"]}}

    def edit(body):
        sid, text = _sid(body), _text(body)
        with lock:
            item = _find(sid, body.get("id"))
            if item["state"] != "queued":
                raise RuntimeError("item is already being steered")
            item["text"] = text

    def remove(body):
        sid = _sid(body)
        with lock:
            item = _find(sid, body.get("id"))
            if item["state"] != "queued":
                raise RuntimeError("item is already being steered")
            queues[sid].remove(item)

    def steer(body):
        sid = _sid(body)
        run = runs.active_for(sid) if runs is not None else None
        with lock:
            item = _find(sid, body.get("id"))
            if item["state"] != "queued":
                return
            if not run:
                raise RuntimeError("no running task to steer")
            item["state"], item["run_id"] = "steering", run["id"]
        try:
            ok = runs.push(run["id"], "steer", {"id": item["id"], "text": item["text"]})
        except Exception:
            ok = False
        if not ok:
            with lock:
                item["state"] = "queued"
                item.pop("run_id", None)
            raise RuntimeError("the running task can no longer be steered")

    def on_event(data, nxt=None):
        try:
            name, payload, sid = data.get("name"), data.get("data") or {}, data.get("session_id")
            if name in ("plugin.steer.applied", "plugin.steer.unused") and sid:
                ids = set(payload.get("ids") or [])
                with lock:
                    items = queues.get(sid, [])
                    if name == "plugin.steer.applied":
                        queues[sid] = [i for i in items if i["id"] not in ids]
                    else:
                        back = [i for i in items if i["id"] in ids]
                        for i in back:
                            i["state"] = "queued"
                            i.pop("run_id", None)
                        # Unused steering goes back to the head of the queue, in order.
                        queues[sid] = back + [i for i in items if i["id"] not in ids]
                _publish()
        except Exception:
            pass
        return nxt(data) if nxt else None

    def send(body):
        """Send one queued item now (used after a stopped run left items waiting)."""
        sid = _sid(body)
        if runs is not None and runs.active_for(sid):
            raise RuntimeError("a task is still running; steer the item instead")
        with lock:
            item = _find(sid, body.get("id"))
            text = item["text"]
        code, reply = frontend.submit(text, session_id=sid, source="user")
        if code >= 400:
            raise RuntimeError(reply.get("error") or "run could not be started")
        with lock:
            held.discard(sid)
            if item in queues.get(sid, []):
                queues[sid].remove(item)

    def _drain(sid, auto=True):
        # Arrival order with conductor wake-ups: children that finished before the
        # first queued message are reported first; that run's end drains us again.
        since = ctx.get("conductor.pending_since")
        first = since(sid) if callable(since) else None
        with lock:
            items = queues.get(sid, [])
            if not auto and items:
                held.add(sid)  # a stopped run waits for the user, not for auto-send
            elif auto:
                held.discard(sid)
            for i in items:
                if i["state"] == "steering":  # worker ended without reporting
                    i["state"] = "queued"
                    i.pop("run_id", None)
            if (not auto or not items or (runs is not None and runs.active_for(sid))
                    or (first is not None and first < items[0].get("created", 0))):
                stopped = True
            else:
                stopped = False
                item = items[0]
        if stopped:
            _publish()
            return
        code, _reply = frontend.submit(item["text"], session_id=sid, source="user")
        if code < 400:
            with lock:
                held.discard(sid)
                if item in queues.get(sid, []):
                    queues[sid].remove(item)
        _publish()

    def on_finished(data, nxt=None):
        sid = data.get("session_id")
        status = (data.get("run") or {}).get("status") or data.get("status")
        if sid:
            # A run the user stopped does not pull the next message in automatically.
            auto = status != "aborted"
            # Off the monitor thread: submit starts a new run and emits events.
            threading.Thread(target=_drain, args=(sid, auto), name="run-queue-drain", daemon=True).start()
        return nxt(data) if nxt else None

    ctx.provide("run_queue.peek", peek)
    if runs is not None:
        ctx.scope.add(runs.register_worker_plugin("ga-steer"))
    ctx.on("web.snapshot", snapshot)
    ctx.on("run.event", on_event)
    ctx.on("run.finished", on_finished)
    script = HERE / "client.js"
    ctx.scope.add(host.register("run-queue", script=script if script.is_file() else None,
                                style=HERE / "client.css", order=35,
                                routes={("POST", "add"): _route(add), ("POST", "edit"): _route(edit),
                                        ("POST", "remove"): _route(remove), ("POST", "steer"): _route(steer),
                                        ("POST", "send"): _route(send)}))
