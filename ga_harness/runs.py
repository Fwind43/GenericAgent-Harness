"""Durable, frontend-neutral runs; every execution owns an isolated process.

The host alone owns SQLite. Worker configuration is passed in memory, never saved
in run records. One host must own a session database at a time.
"""
from __future__ import annotations

import copy
import json
import multiprocessing
import threading
import time
import uuid

from .run_output import apply_event
from .sessions import settle
from .worker import run_worker

ACTIVE = ("running", "cancelling")
TERMINAL = ("done", "error", "aborted", "interrupted")


class Runs:
    def __init__(self, sessions, workspaces, recipe, *, emit=None, max_parallel=4,
                 cancel_grace=5.0, process_context=None, worker=run_worker):
        self.sessions, self.workspaces, self.recipe = sessions, workspaces, recipe
        self.lock = sessions.lock
        self.emit = emit or (lambda name, data: None)
        self.max_parallel = max(1, int(max_parallel))
        self.cancel_grace = max(0.1, float(cancel_grace))
        self.process_context = process_context or multiprocessing.get_context("spawn")
        self.worker = worker
        self.live = {}
        self.closed = False
        self._init()

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

    @staticmethod
    def _append(db, rid, kind, data):
        seq = db.execute("SELECT seq FROM runs WHERE id=?", (rid,)).fetchone()[0] + 1
        db.execute("UPDATE runs SET seq=? WHERE id=?", (seq, rid))
        db.execute("INSERT INTO run_events VALUES(?,?,?,?,?)",
                   (rid, seq, kind, json.dumps(data, ensure_ascii=False, allow_nan=False), time.time()))
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
            return dict(row)

    def listing(self, session_id=None, *, limit=100):
        limit = max(1, min(int(limit), 500))
        if session_id is not None and not isinstance(session_id, str):
            raise ValueError("invalid session_id")
        with self.lock, self.sessions._db() as db:
            if session_id is None:
                rows = db.execute("SELECT * FROM runs ORDER BY created DESC LIMIT ?", (limit,))
            else:
                rows = db.execute("SELECT * FROM runs WHERE session_id=? ORDER BY created DESC LIMIT ?", (session_id, limit))
            return [dict(row) for row in rows]

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

    def start(self, task, *, session_id=None, source="user", timeout=None):
        if not isinstance(task, str) or not task.strip():
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
                raise RuntimeError("parallel run limit reached")
            session = self.sessions.get(session_id) if session_id is not None else self.sessions.current()
            sid = session["id"]
            if self.active_for(sid):
                raise RuntimeError("this session already has an active run")
            scope = self.workspaces.context(sid)
            recipe = self.recipe()
            rid = uuid.uuid4().hex
            messages = copy.deepcopy(session["messages"])
            messages.extend([{"role": "user", "text": task.strip(), "run_id": rid},
                             {"role": "assistant", "text": "", "status": "running", "turns": [], "run_id": rid}])
            payload = {"session_id": sid, "run_id": rid, "state": copy.deepcopy(session["state"]),
                       "scope": scope, "task": task.strip(), "source": source, "timeout": timeout}
            # Prepare the process before reserving storage; starting it comes only
            # after the durable reservation and initial messages have committed.
            parent, child = self.process_context.Pipe(duplex=True)
            process = self.process_context.Process(target=self.worker, args=(child, recipe, payload),
                                                   name="gah-run-" + rid[:8], daemon=True)
            try:
                with self.sessions._db() as db:
                    db.execute("INSERT INTO runs(id,session_id,source,status,workspace,project_id,created) VALUES(?,?,?,'running',?,?,?)",
                               (rid, sid, source, scope["workspace"], scope.get("project_id") or "", time.time()))
                    self.sessions._write(db, session, messages, session["state"])
                    self._append(db, rid, "run.started", {"status": "running"})
            except Exception:
                parent.close()
                child.close()
                raise
            live = {"process": process, "connection": parent, "messages": messages,
                    "state": copy.deepcopy(session["state"]), "cancel_at": None,
                    "thread": None, "started": time.monotonic(), "timeout": timeout}
            self.live[rid] = live
            self.sessions.active.add(sid)
            start_error = None
            try:
                process.start()
                child.close()
            except Exception:
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
        with self.lock:
            live = self.live.get(rid)
            if live is None:
                return
            record = self.get(rid)
            if record["status"] not in ACTIVE:
                return
            messages = copy.deepcopy(live["messages"])
            apply_event(messages, name, data)
            session = self.sessions.get(record["session_id"])
            with self.sessions._db() as db:
                self.sessions._write(db, session, messages, live["state"])
                seq = self._append(db, rid, "run.event", {"name": name, "data": data})
            live["messages"] = messages
            record["seq"] = seq
        self._notify("run.event", record, name=name, data=data, message=messages[-1])

    def _finish(self, rid, status, error=None, *, state=None, text=None):
        with self.lock:
            live = self.live.get(rid)
            if live is None:
                return
            record = self.get(rid)
            if record["status"] not in ACTIVE:
                return
            if record["status"] == "cancelling":
                status = "aborted"
            messages = copy.deepcopy(live["messages"])
            if text is not None and messages and not messages[-1].get("turns"):
                messages[-1]["text"] = text
            settle(messages, status, error)
            session = self.sessions.get(record["session_id"])
            with self.sessions._db() as db:
                self.sessions._write(db, session, messages, state if state is not None else live["state"])
                self._append(db, rid, "run.finished", {"status": status, "error": error})
                db.execute("UPDATE runs SET status=?,ended=?,error=? WHERE id=?", (status, time.time(), error, rid))
            self.sessions.active.discard(record["session_id"])
            del self.live[rid]
            record = self.get(rid)
        self._notify("run.finished", record, run=record, message=messages[-1])

    def _monitor(self, rid, live):
        connection, process = live["connection"], live["process"]
        try:
            while True:
                if connection.poll(0.1):
                    packet = connection.recv()
                    if packet.get("kind") == "event":
                        self._event(rid, packet)
                    elif packet.get("kind") == "done":
                        self._finish(rid, "done", state=packet.get("state"), text=packet.get("text"))
                        break
                    elif packet.get("kind") == "error":
                        self._finish(rid, "error", packet.get("error") or "Worker failed")
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
            self._finish(rid, "error", "Worker connection closed before completion")
        except Exception:
            # Leave a failed persistence transaction untouched. Recovery on the
            # next startup will mark the durable reservation interrupted.
            try:
                self._finish(rid, "error", "Run output could not be saved")
            except Exception:
                pass
        finally:
            connection.close()
            if process.is_alive():
                process.join(timeout=0.2)
            if process.is_alive():
                # Only this service's own spawned worker, never a host/GA process.
                process.terminate()
            process.join(timeout=2)

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
            try:
                live["connection"].send({"kind": "cancel"})
            except (BrokenPipeError, EOFError, OSError):
                pass
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
