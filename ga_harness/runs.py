"""Durable, frontend-neutral runs; every execution owns an isolated process.

The host alone owns SQLite. Worker configuration is passed in memory, never saved
in run records. One host must own a session database at a time.
"""
from __future__ import annotations

import copy
import json
import logging
import multiprocessing
import threading
import time
import uuid

from . import presets, uploads
from .run_output import apply_event
from .sessions import settle
from .worker import run_worker

ACTIVE = ("running", "cancelling")
TERMINAL = ("done", "error", "aborted", "interrupted")
# High-frequency fragments; the final assistant.text/turn events are durable.
STREAM_EVENTS = ("assistant.delta", "agent.chunk")
STREAM_FLUSH_SECONDS = 1.0
# Worker-plugin events: broadcast and logged, never folded into the transcript.
PLUGIN_EVENT_PREFIX = "plugin."

log = logging.getLogger(__name__)


class SessionBusy(RuntimeError):
    """The session already has an active run."""


class RunLimitReached(RuntimeError):
    """The host's parallel run limit is reached."""


class RpcCall:
    """One in-flight worker -> host request, handed to a registered RPC handler."""

    def __init__(self, service, run_id, session_id, body):
        self.service, self.run_id, self.session_id, self.body = service, run_id, session_id, body
        # Set when the calling run finishes or is cancelled; long handlers should poll it.
        self.cancelled = threading.Event()


class Runs:
    def __init__(self, sessions, workspaces, recipe, *, emit=None, max_parallel=4,
                 cancel_grace=5.0, process_context=None, worker=run_worker,
                 plugin_handler=None):
        self.sessions, self.workspaces, self.recipe = sessions, workspaces, recipe
        # Host-side handler for plugin requests raised by a worker's agent tool.
        self.plugin_handler = plugin_handler
        self.rpc = {}
        self.worker_plugins = {}
        self.lock = sessions.lock
        self.emit = emit or (lambda name, data: None)
        self.max_parallel = max(1, int(max_parallel))
        self.cancel_grace = max(0.1, float(cancel_grace))
        self.process_context = process_context or multiprocessing.get_context("spawn")
        self.worker = worker
        self.live = {}
        self.closed = False
        if plugin_handler is not None:
            self.register_rpc("plugin_control", lambda body, call: plugin_handler(body))
        self._init()

    # -- extension points for plugins ------------------------------------------------

    def register_rpc(self, service, handler):
        """Serve ``host.call(service, body)`` from worker plugins.

        ``handler(body, call)`` runs on its own thread, so it may block (start and
        wait for other runs, ask the UI, ...). ``call`` is an :class:`RpcCall`. Its
        return value must be picklable; exceptions are reported to the caller.
        Returns a disposer.
        """
        if not isinstance(service, str) or not service.strip():
            raise ValueError("rpc service name is required")
        if not callable(handler):
            raise TypeError("rpc handler must be callable")
        with self.lock:
            if service in self.rpc:
                raise ValueError(f"rpc service {service!r} is already registered")
            self.rpc[service] = handler

        def dispose():
            with self.lock:
                if self.rpc.get(service) is handler:
                    del self.rpc[service]
        return dispose

    def register_worker_plugin(self, name):
        """Mount an execution plugin in every subsequently started worker.

        Equivalent to listing it in ``run-store.worker_plugins``, but owned by the
        calling plugin. The plugin must be installed but need not be active in the
        host (worker-only plugins). Host/UI/storage plugins are still refused.
        Returns a disposer.
        """
        if not isinstance(name, str) or not name.strip():
            raise ValueError("plugin name is required")
        with self.lock:
            self.worker_plugins[name] = self.worker_plugins.get(name, 0) + 1

        def dispose():
            with self.lock:
                count = self.worker_plugins.get(name, 0) - 1
                if count > 0:
                    self.worker_plugins[name] = count
                else:
                    self.worker_plugins.pop(name, None)
        return dispose

    def extra_worker_plugins(self):
        with self.lock:
            return set(self.worker_plugins)

    def push(self, run_id, topic, data=None):
        """Deliver ``(topic, data)`` to the run's worker (``host.on_push`` listeners).

        Returns False when the run is no longer live in this host.
        """
        if not isinstance(topic, str) or not topic:
            raise ValueError("push topic is required")
        with self.lock:
            live = self.live.get(run_id)
        if live is None:
            return False
        return self._send(live, {"kind": "push", "topic": topic, "data": data})

    def wait(self, run_id, timeout=None):
        """Block until the run is terminal (or ``timeout`` elapses); return its record."""
        with self.lock:
            live = self.live.get(run_id)
        if live is not None:
            live["finished"].wait(timeout)
        return self.get(run_id)

    def _send(self, live, packet):
        try:
            with live["send_lock"]:
                live["connection"].send(packet)
            return True
        except (BrokenPipeError, EOFError, OSError, ValueError):
            return False

    def _init(self):
        with self.lock:
            self.sessions.current()
            with self.sessions._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                    source TEXT NOT NULL, status TEXT NOT NULL,
                    workspace TEXT NOT NULL, project_id TEXT NOT NULL,
                    created REAL NOT NULL, ended REAL, error TEXT,
                    seq INTEGER NOT NULL DEFAULT 0)""")
                db.execute("""CREATE UNIQUE INDEX IF NOT EXISTS run_session_active
                    ON runs(session_id) WHERE status IN ('running','cancelling')""")
                db.execute("""CREATE TABLE IF NOT EXISTS run_events (
                    run_id TEXT NOT NULL, seq INTEGER NOT NULL,
                    kind TEXT NOT NULL, data TEXT NOT NULL, created REAL NOT NULL,
                    PRIMARY KEY(run_id,seq))""")
                for row in db.execute("SELECT * FROM runs WHERE status IN ('running','cancelling')").fetchall():
                    error = "Service interrupted; not automatically retried"
                    self._append(db, row["id"], "run.finished", {"status": "interrupted", "error": error})
                    db.execute("UPDATE runs SET status='interrupted',ended=?,error=? WHERE id=?",
                               (time.time(), error, row["id"]))
                    session = db.execute("SELECT * FROM sessions WHERE id=? AND deleted=0", (row["session_id"],)).fetchone()
                    if session is not None:
                        current = self.sessions._decode(session)
                        settle(current["messages"], "interrupted", error)
                        self.sessions._write(db, current, current["messages"], current["state"])

    def _append(self, db, rid, kind, data):
        seq = self._next_seq(db, rid)
        db.execute("INSERT INTO run_events VALUES(?,?,?,?,?)",
                   (rid, seq, kind, json.dumps(data, ensure_ascii=False, allow_nan=False), time.time()))
        return seq

    def _next_seq(self, db, rid):
        # Transient stream events advance the live sequence without event rows,
        # so durable events must continue after the highest sequence broadcast.
        seq = db.execute("SELECT seq FROM runs WHERE id=?", (rid,)).fetchone()[0]
        live = self.live.get(rid)
        if live is not None:
            seq = max(seq, live["seq"])
        seq += 1
        if live is not None:
            live["seq"] = seq
        db.execute("UPDATE runs SET seq=? WHERE id=?", (seq, rid))
        return seq

    def _notify(self, kind, record, **data):
        # Subscribers run outside the storage lock. A subscriber must not roll back
        # a committed run or prevent the monitor from draining the worker pipe.
        envelope = {"run_id": record["id"], "session_id": record["session_id"],
                    "seq": record["seq"], **data}
        try:
            self.emit(kind, envelope)
        except Exception:
            pass

    def get(self, run_id):
        if not isinstance(run_id, str) or not run_id:
            raise ValueError("run_id is required")
        with self.lock, self.sessions._db() as db:
            row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if row is None:
                raise ValueError("run not found")
            return self._row(row)

    def listing(self, session_id=None, *, limit=100):
        limit = max(1, min(int(limit), 500))
        if session_id is not None and not isinstance(session_id, str):
            raise ValueError("invalid session_id")
        with self.lock, self.sessions._db() as db:
            if session_id is None:
                rows = db.execute("SELECT * FROM runs ORDER BY created DESC LIMIT ?", (limit,))
            else:
                rows = db.execute("SELECT * FROM runs WHERE session_id=? ORDER BY created DESC LIMIT ?", (session_id, limit))
            return [self._row(row) for row in rows]

    def _row(self, row):
        # Stream fragments advance only the in-memory sequence; report it so a
        # state refresh does not move a client's cursor behind broadcast events.
        record = dict(row)
        live = self.live.get(record["id"])
        if live is not None:
            record["seq"] = max(record["seq"], live["seq"])
        return record

    def events(self, run_id, *, after=0, limit=200):
        self.get(run_id)
        after, limit = max(0, int(after)), max(1, min(int(limit), 500))
        with self.lock, self.sessions._db() as db:
            return [{**dict(row), "data": json.loads(row["data"])} for row in db.execute(
                "SELECT * FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?", (run_id, after, limit))]

    def active_for(self, session_id):
        with self.lock, self.sessions._db() as db:
            row = db.execute("SELECT * FROM runs WHERE session_id=? AND status IN ('running','cancelling')", (session_id,)).fetchone()
            return dict(row) if row else None

    @property
    def busy(self):
        with self.lock:
            return bool(self.live)

    def _seed_selection(self, state):
        state = dict(state or {})
        agent = getattr(self.sessions, "agent", None)
        backend = getattr(getattr(agent, "llmclient", None), "backend", None)
        name = getattr(backend, "name", None)
        if not state.get("model") and isinstance(name, str) and name:
            state["model"] = name
        if "effort" not in state and agent is not None:
            state["effort"] = getattr(agent, "gah_reasoning_effort", None)
        return state

    def start(self, task, *, session_id=None, source="user", timeout=None, attachments=None):
        files = uploads.resolve(attachments)
        if not isinstance(task, str) or not (task.strip() or files):
            raise ValueError("empty task")
        if not isinstance(source, str) or not source.strip() or len(source) > 100:
            raise ValueError("invalid source")
        if timeout is not None and (isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout <= 86400):
            raise ValueError("timeout must be between 0 and 86400 seconds")
        parent = child = process = None
        with self.lock:
            if self.closed:
                raise RuntimeError("run service is stopping")
            if len(self.live) >= self.max_parallel:
                raise RunLimitReached("parallel run limit reached")
            session = self.sessions.get(session_id) if session_id is not None else self.sessions.current()
            sid = session["id"]
            if self.active_for(sid):
                raise SessionBusy("this session already has an active run")
            scope = self.workspaces.context(sid)
            recipe = self.recipe()
            preset_id = (session["state"] or {}).get("preset")
            if preset_id:
                preset = presets.get(preset_id)
                if preset is None:
                    raise ValueError(f"agent preset {preset_id!r} is not available")
                recipe = presets.apply(recipe, preset)
            rid = uuid.uuid4().hex
            created_at = time.time()
            # A session that never stored a model/effort runs with the selection the
            # UI shows (the host agent's), not the worker's config default.
            session["state"] = self._seed_selection(session["state"])
            messages = copy.deepcopy(session["messages"])
            user = {"role": "user", "text": task.strip(), "run_id": rid, "created_at": created_at}
            if source and source != "user":
                user["source"] = source  # e.g. "conductor": plugin-written wake-up, rendered as a notice
            if files:
                user["attachments"] = [{k: a[k] for k in ("name", "mime", "size", "image", "url")} for a in files]
            messages.extend([user,
                             {"role": "assistant", "text": "", "status": "running", "turns": [],
                              "run_id": rid, "created_at": created_at}])
            payload = {"session_id": sid, "run_id": rid, "state": copy.deepcopy(session["state"]),
                       "scope": scope, "task": uploads.task_text(task.strip(), files), "source": source,
                       "images": uploads.image_paths(files), "timeout": timeout}
            # Prepare the process before reserving storage; starting it comes only
            # after the durable reservation and initial messages have committed.
            parent, child = self.process_context.Pipe(duplex=True)
            process = self.process_context.Process(target=self.worker, args=(child, recipe, payload),
                                                   name="gah-run-" + rid[:8], daemon=True)
            try:
                with self.sessions._db() as db:
                    db.execute("INSERT INTO runs(id,session_id,source,status,workspace,project_id,created) VALUES(?,?,?,'running',?,?,?)",
                               (rid, sid, source, scope["workspace"], scope.get("project_id") or "", created_at))
                    self.sessions._write(db, session, messages, session["state"])
                    started_seq = self._append(db, rid, "run.started", {"status": "running"})
            except Exception:
                parent.close()
                child.close()
                raise
            live = {"process": process, "connection": parent, "messages": messages,
                    "state": copy.deepcopy(session["state"]), "cancel_at": None,
                    "thread": None, "started": time.monotonic(), "timeout": timeout,
                    "session_id": sid, "seq": started_seq, "dirty": False, "flushed": time.monotonic(),
                    "send_lock": threading.Lock(), "calls": {}, "finished": threading.Event()}
            self.live[rid] = live
            self.sessions.active.add(sid)
            start_error = None
            try:
                process.start()
                child.close()
                log.info("run %s start session=%s worker_pid=%s", rid, sid, process.pid)
            except Exception:
                log.exception("run %s: worker could not start", rid)
                child.close()
                parent.close()
                start_error = "Worker could not start"
            thread = threading.Thread(target=self._monitor, args=(rid, live), name="run-monitor-" + rid[:8], daemon=True)
            live["thread"] = thread if start_error is None else None
            started = self.get(rid)
        # Even startup failures notify only after releasing the session lock.
        self._notify("run.started", started, run=started, messages=messages)
        if start_error is not None:
            self._finish(rid, "error", start_error)
        else:
            try:
                thread.start()
            except Exception:
                if process.is_alive():
                    process.terminate()
                process.join(timeout=2)
                parent.close()
                self._finish(rid, "error", "Worker monitor could not start")
        return self.get(rid)

    def _event(self, rid, packet):
        name, data = packet.get("name"), packet.get("data")
        if not isinstance(name, str):
            return
        if name.startswith(PLUGIN_EVENT_PREFIX):
            # Durable and broadcast. Only explicit ``notes`` reach the transcript.
            with self.lock:
                live = self.live.get(rid)
                if live is None:
                    return
                noted = self._fold_notes(live["messages"], data)
                with self.sessions._db() as db:
                    seq = self._append(db, rid, "run.event", {"name": name, "data": data})
                    if noted:
                        self._checkpoint(db, live)
                record = {"id": rid, "session_id": live["session_id"], "seq": seq}
                message = live["messages"][-1]
            self._notify("run.event", record, name=name, data=data, message=message)
            return
        with self.lock:
            live = self.live.get(rid)
            if live is None:
                return
            # Output is accumulated in place; only this run's monitor thread mutates it.
            messages = live["messages"]
            now = time.monotonic()
            apply_event(messages, name, data)
            if name in STREAM_EVENTS:
                # Stream fragments are broadcast with a live sequence number but are
                # not stored as event rows. The transcript is checkpointed at most
                # once per interval; durable events and completion save it in full.
                live["seq"] = seq = live["seq"] + 1
                if now - live["flushed"] >= STREAM_FLUSH_SECONDS:
                    with self.sessions._db() as db:
                        self._checkpoint(db, live)
                else:
                    live["dirty"] = True
            else:
                with self.sessions._db() as db:
                    seq = self._append(db, rid, "run.event", {"name": name, "data": data})
                    self._checkpoint(db, live)
            record = {"id": rid, "session_id": live["session_id"], "seq": seq}
        self._notify("run.event", record, name=name, data=data, message=messages[-1])

    @staticmethod
    def _fold_notes(messages, data):
        """Attach plugin ``notes`` ([{kind, text}]) to the running assistant message.

        A note is placed after ``turn``: the plugin's explicit integer ``turn`` when
        given (plugin events and agent events can arrive in either order), otherwise
        the last started turn. The UI uses it to keep notes in sequence with steps.
        """
        notes = data.get("notes") if isinstance(data, dict) else None
        if not isinstance(notes, list) or not messages or messages[-1].get("status") != "running":
            return False
        message = messages[-1]
        turns = [t for t in message.get("turns") or [] if isinstance(t, dict)]
        latest = max((t.get("turn") or 0 for t in turns), default=0) or len(turns)
        added = False
        for note in notes:
            if isinstance(note, dict) and isinstance(note.get("text"), str) and note["text"].strip():
                kind = note.get("kind") if isinstance(note.get("kind"), str) else "note"
                turn = note.get("turn")
                turn = turn if isinstance(turn, int) and not isinstance(turn, bool) else latest
                message.setdefault("notes", []).append(
                    {"kind": kind, "text": note["text"], "turn": turn, "created_at": time.time()})
                added = True
        return added

    def _checkpoint(self, db, live):
        session = self.sessions.get(live["session_id"])
        self.sessions._write(db, session, live["messages"], live["state"])
        live["dirty"], live["flushed"] = False, time.monotonic()

    def _finish(self, rid, status, error=None, *, state=None, text=None):
        with self.lock:
            live = self.live.get(rid)
            if live is None:
                return
            record = self.get(rid)
            if record["status"] not in ACTIVE:
                return
            log.info("run %s finish status=%s error=%s", rid, status, error)
            if record["status"] == "cancelling":
                status = "aborted"
            messages = copy.deepcopy(live["messages"])
            if text is not None and messages and not messages[-1].get("turns"):
                messages[-1]["text"] = text
            settle(messages, status, error)
            session = self.sessions.get(record["session_id"])
            state = state if isinstance(state, dict) else live["state"]
            with self.sessions._db() as db:
                self.sessions._write(db, session, messages, state)
                self._append(db, rid, "run.finished", {"status": status, "error": error})
                db.execute("UPDATE runs SET status=?,ended=?,error=? WHERE id=?", (status, time.time(), error, rid))
            self.sessions.active.discard(record["session_id"])
            del self.live[rid]
            for call in list(live["calls"].values()):
                call.cancelled.set()
            live["finished"].set()
            record = self.get(rid)
        self._notify("run.finished", record, run=record, message=messages[-1])

    def _rpc_request(self, rid, live, packet):
        # Legacy ``plugin`` packets are plugin_control requests.
        legacy = packet.get("kind") == "plugin"
        service = "plugin_control" if legacy else packet.get("service")
        call_id = packet.get("id")
        call = RpcCall(service, rid, live["session_id"], packet.get("body"))
        with self.lock:
            handler = self.rpc.get(service) if isinstance(service, str) else None
            live["calls"][call_id] = call
        if live["cancel_at"] is not None:
            call.cancelled.set()

        def serve():
            reply = {"kind": "plugin_result" if legacy else "rpc_result", "id": call_id}
            try:
                if handler is None:
                    raise LookupError(f"rpc service {service!r} is not available in this host")
                reply["result"] = handler(call.body, call)
            except Exception as exc:  # reported back to the caller, never fatal to the run
                reply["error"] = f"{type(exc).__name__}: {exc}"
            finally:
                with self.lock:
                    live["calls"].pop(call_id, None)
            if not self._send(live, reply) and "result" in reply:
                # Unpicklable results must still answer the caller.
                self._send(live, {"kind": reply["kind"], "id": call_id,
                                  "error": "TypeError: rpc result could not be sent"})

        # Handlers may block; the monitor must keep draining events and cancels.
        threading.Thread(target=serve, name=f"run-rpc-{rid[:8]}", daemon=True).start()

    def _monitor(self, rid, live):
        connection, process = live["connection"], live["process"]
        try:
            while True:
                if connection.poll(0.1):
                    packet = connection.recv()
                    if packet.get("kind") == "event":
                        self._event(rid, packet)
                    elif packet.get("kind") in ("rpc", "plugin"):
                        self._rpc_request(rid, live, packet)
                    elif packet.get("kind") == "done":
                        self._finish(rid, "done", state=packet.get("state"), text=packet.get("text"))
                        break
                    elif packet.get("kind") == "error":
                        self._finish(rid, "error", packet.get("error") or "Worker failed", state=packet.get("state"))
                        break
                with self.lock:
                    cancel_at = live["cancel_at"]
                if cancel_at is not None and time.monotonic() - cancel_at >= self.cancel_grace:
                    self._finish(rid, "aborted")
                    break
                if live["timeout"] and time.monotonic() - live["started"] > live["timeout"] + self.cancel_grace:
                    self.cancel(rid)
                if not process.is_alive() and not connection.poll():
                    self._finish(rid, "error", "Worker exited before completion")
                    break
        except (EOFError, OSError):
            log.warning("run %s: worker connection closed before completion", rid, exc_info=True)
            try:
                self._finish(rid, "error", "Worker connection closed before completion")
            except Exception:
                log.exception("run %s: could not record closed worker connection", rid)
        except Exception:
            log.exception("run %s: monitor failed", rid)
            try:
                self._finish(rid, "error", "Run output could not be saved")
            except Exception:
                log.exception("run %s: could not record monitor failure", rid)
        finally:
            # The monitor is the only owner of a live run; never exit leaving it active.
            try:
                self._abandon(rid, "Run monitor stopped before completion")
            except Exception:
                log.exception("run %s: could not release abandoned run", rid)
            connection.close()
            if process.is_alive():
                process.join(timeout=0.2)
            if process.is_alive():
                # Only this service's own spawned worker, never a host/GA process.
                process.terminate()
            process.join(timeout=2)

    def _abandon(self, rid, error):
        """Release a run whose monitor exits without a recorded terminal status."""
        with self.lock:
            live = self.live.pop(rid, None)
            if live is None:
                return
            self.sessions.active.discard(live["session_id"])
            for call in list(live["calls"].values()):
                call.cancelled.set()
            live["finished"].set()
        log.error("run %s: abandoned while active; marking error", rid)
        messages = copy.deepcopy(live["messages"])
        record = None
        try:
            settle(messages, "error", error)
            with self.lock:
                if self.get(rid)["status"] in ACTIVE:
                    session = self.sessions.get(live["session_id"])
                    with self.sessions._db() as db:
                        self.sessions._write(db, session, messages, live["state"])
                        self._append(db, rid, "run.finished", {"status": "error", "error": error})
                        db.execute("UPDATE runs SET status='error',ended=?,error=? WHERE id=?", (time.time(), error, rid))
                record = self.get(rid)
        except Exception:
            log.exception("run %s: could not save abandoned transcript", rid)
            try:
                with self.lock, self.sessions._db() as db:
                    db.execute("UPDATE runs SET status='error',ended=?,error=? WHERE id=? AND status IN ('running','cancelling')",
                               (time.time(), error, rid))
                    record = self.get(rid)
            except Exception:
                log.exception("run %s: could not mark abandoned run", rid)
        if record is None:
            record = {"id": rid, "session_id": live["session_id"], "seq": None, "status": "error", "error": error}
        self._notify("run.finished", record, run=record, message=messages[-1] if messages else None)

    def cancel(self, run_id):
        with self.lock:
            record = self.get(run_id)
            if record["status"] not in ACTIVE:
                return record
            live = self.live.get(run_id)
            if live is None:
                raise RuntimeError("run is not owned by this host")
            if live["cancel_at"] is not None:
                return record
            with self.sessions._db() as db:
                self._append(db, run_id, "run.cancelling", {"status": "cancelling"})
                db.execute("UPDATE runs SET status='cancelling' WHERE id=?", (run_id,))
            live["cancel_at"] = time.monotonic()
            for call in list(live["calls"].values()):
                call.cancelled.set()
            self._send(live, {"kind": "cancel"})
            record = self.get(run_id)
        self._notify("run.cancelling", record, run=record)
        return record

    def close(self):
        with self.lock:
            self.closed = True
            items = list(self.live.items())
        for rid, _ in items:
            try:
                self.cancel(rid)
            except Exception:
                pass
        deadline = time.monotonic() + self.cancel_grace + 3
        for _, live in items:
            thread = live["thread"]
            if thread and thread is not threading.current_thread():
                thread.join(timeout=max(0, deadline - time.monotonic()))
