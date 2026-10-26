"""Durable conversation storage; independent of any frontend or GA import."""
from __future__ import annotations

import copy
from contextlib import contextmanager
import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from types import SimpleNamespace


def capture(agent):
    handler = getattr(agent, "handler", None)
    working = getattr(handler, "working", {})
    return copy.deepcopy({
        "history": getattr(handler, "history_info", agent.history),
        "raw": agent.llmclient.backend.history,
        "working": {k: working[k] for k in ("key_info", "passed_sessions") if k in working},
        "model": getattr(agent.llmclient.backend, "name", ""),
        "effort": getattr(agent, "gah_reasoning_effort", None),
    })


EFFORTS = ("low", "medium", "high", "xhigh", "max")


def apply_effort(agent):
    """Per-conversation reasoning effort override; None keeps the model's own config."""
    backend = getattr(getattr(agent, "llmclient", None), "backend", None)
    if backend is None or not hasattr(backend, "reasoning_effort"):
        return
    if not hasattr(backend, "_gah_effort_default"):
        backend._gah_effort_default = backend.reasoning_effort
    backend.reasoning_effort = getattr(agent, "gah_reasoning_effort", None) or backend._gah_effort_default


def restore(agent, state):
    """GA creates a real handler on the next task; only its working memory survives."""
    state = copy.deepcopy(state)
    for client in agent.llmclients:
        if hasattr(client, "backend"):
            client.backend.history = []
        if hasattr(client, "last_tools"):
            client.last_tools = ""
    agent.history = state.get("history", [])
    effort = state.get("effort")
    agent.gah_reasoning_effort = effort if effort in EFFORTS else None
    agent.llmclient.backend.history = state.get("raw", [])
    working = state.get("working", {})
    agent.handler = SimpleNamespace(working=working, code_stop_signal=[]) if working else None
    if hasattr(agent, "all_outputs"):
        agent.all_outputs = []


class Sessions:
    """One selected conversation per agent. SQLite commits data + selection atomically.

    Deleted sessions are tombstoned, not erased. Never store API credentials here.
    The caller serializes run/selection operations; busy checks also guard direct use.
    """
    def __init__(self, agent, path):
        self.agent = agent
        self.path = Path(path).expanduser().resolve()
        self.lock = threading.RLock()
        self._ready = False
        self.reserved = False

    @contextmanager
    def _db(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def _idle(self):
        q = getattr(self.agent, "task_queue", None)
        if self.reserved or getattr(self.agent, "is_running", False) or getattr(q, "unfinished_tasks", 0):
            raise RuntimeError("agent is still running")

    def _new(self, db, workspace="", project_id=""):
        sid = uuid.uuid4().hex
        db.execute("INSERT INTO sessions (id, title, updated, messages, state, deleted, workspace, project_id) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
                   (sid, "新会话", time.time(), "[]", "{}", workspace, project_id))
        return sid

    def _select(self, db, sid):
        db.execute("INSERT OR REPLACE INTO meta VALUES ('current', ?)", (sid,))

    def _init(self):
        if self._ready:
            return
        self._idle()
        with self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated REAL NOT NULL, messages TEXT NOT NULL, state TEXT NOT NULL, deleted INTEGER NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            columns = {r[1] for r in db.execute("PRAGMA table_info(sessions)")}
            for column in ("workspace", "project_id"):
                if column not in columns:
                    db.execute(f"ALTER TABLE sessions ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
            row = db.execute("SELECT value FROM meta WHERE key='current'").fetchone()
            sid = row[0] if row else None
            row = db.execute("SELECT * FROM sessions WHERE id=? AND deleted=0", (sid,)).fetchone()
            if row is None:
                sid = self._new(db)
                self._select(db, sid)
            else:
                messages = json.loads(row["messages"])
                for message in messages:
                    if message.get("status") == "running":
                        message.update(status="interrupted", error="服务中断，未自动重试")
                        for turn in message.get("turns", []):
                            if turn.get("status") == "running":
                                turn["status"] = "interrupted"
                            for tool in turn.get("tools", []):
                                if tool.get("status") == "running":
                                    tool["status"] = "interrupted"
                db.execute("UPDATE sessions SET messages=? WHERE id=?", (json.dumps(messages, ensure_ascii=False), sid))
        self._ready = True
        restore(self.agent, self.current()["state"])

    def current(self):
        with self.lock:
            self._init()
            with self._db() as db:
                row = db.execute("SELECT * FROM sessions WHERE id=(SELECT value FROM meta WHERE key='current') AND deleted=0").fetchone()
            result = dict(row)
            result["messages"] = json.loads(result["messages"])
            result["state"] = json.loads(result["state"])
            return result

    def listing(self):
        with self.lock:
            self._init()
            with self._db() as db:
                return [dict(r) for r in db.execute("SELECT id,title,updated,workspace,project_id FROM sessions WHERE deleted=0 ORDER BY updated DESC,id")]

    def save(self, messages):
        with self.lock:
            self._idle()
            current = self.current()
            title = current["title"]
            if title == "新会话":
                first = next((m.get("text", "") for m in messages if m.get("role") == "user"), "")
                title = " ".join(first.split())[:60] or title
            payload = json.dumps(messages, ensure_ascii=False, allow_nan=False)
            state = json.dumps(capture(self.agent), ensure_ascii=False, allow_nan=False)
            with self._db() as db:
                db.execute("UPDATE sessions SET title=?,updated=?,messages=?,state=? WHERE id=?",
                           (title, time.time(), payload, state, current["id"]))

    def change(self, action, sid=None, title=None, *, workspace=None, project_id=None):
        with self.lock:
            self._idle()
            current = self.current()
            with self._db() as db:
                if action == "new":
                    sid = self._new(db, current["workspace"] if workspace is None else workspace,
                                    current["project_id"] if project_id is None else project_id)
                elif action in ("select", "rename", "delete"):
                    if not isinstance(sid, str) or not db.execute("SELECT 1 FROM sessions WHERE id=? AND deleted=0", (sid,)).fetchone():
                        raise ValueError("session not found")
                else:
                    raise ValueError("unknown session action")
                if action == "rename":
                    if not isinstance(title, str) or not title.strip() or len(title.strip()) > 120:
                        raise ValueError("title must contain 1-120 characters")
                    db.execute("UPDATE sessions SET title=? WHERE id=?", (title.strip(), sid))
                elif action == "delete":
                    db.execute("UPDATE sessions SET deleted=1 WHERE id=?", (sid,))
                    if sid == current["id"]:
                        sid = self._new(db, current["workspace"], current["project_id"])
                        self._select(db, sid)
                else:
                    self._select(db, sid)
            selected = self.current()
            if selected["id"] != current["id"]:
                restore(self.agent, selected["state"])
            return selected
