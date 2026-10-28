"""Run queue: messages sent while a session is busy wait here.

Queued items can be edited or cancelled. "Steer" hands an item to the running
worker (via the ``ga-steer`` worker plugin), which injects it at the next turn
boundary instead of interrupting the task. When a run finishes, the next queued
item of that session is submitted as an ordinary user message.
"""
import threading
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAX_TEXT = 100_000


def apply(ctx, config):
    host, runs, sessions = ctx.get("web.host"), ctx.get("runs"), ctx.get("sessions")
    frontend = host.frontend
    lock = threading.RLock()
    queues = {}  # session_id -> [{"id", "text", "state": "queued" | "steering", "run_id"?}]

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

    def _publish():
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
        item = {"id": uuid.uuid4().hex[:12], "text": text, "state": "queued"}
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
            if item in queues.get(sid, []):
                queues[sid].remove(item)

    def _drain(sid, auto=True):
        with lock:
            items = queues.get(sid, [])
            for i in items:
                if i["state"] == "steering":  # worker ended without reporting
                    i["state"] = "queued"
                    i.pop("run_id", None)
            if not auto or not items or (runs is not None and runs.active_for(sid)):
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
