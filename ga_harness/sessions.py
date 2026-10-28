"""Durable conversations, with optional per-session execution reservations."""
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
    backend = getattr(getattr(agent, "llmclient", None), "backend", None)   # None before any model exists
    return copy.deepcopy({
        "history": getattr(handler, "history_info", agent.history),
        "raw": getattr(backend, "history", []),
        "working": {k: working[k] for k in ("key_info", "passed_sessions") if k in working},
        "model": getattr(backend, "name", ""),
        "effort": getattr(agent, "gah_reasoning_effort", None),
    })


EFFORTS = ("low", "medium", "high", "xhigh", "max")


def apply_effort(agent):
    """Per-conversation override; None keeps the model's own config."""
    backend = getattr(getattr(agent, "llmclient", None), "backend", None)
    if backend is None or not hasattr(backend, "reasoning_effort"):
        return
    if not hasattr(backend, "_gah_effort_default"):
        backend._gah_effort_default = backend.reasoning_effort
    backend.reasoning_effort = getattr(agent, "gah_reasoning_effort", None) or backend._gah_effort_default


def restore(agent, state):
    """GA creates a real handler on the next task; only its working memory survives."""
    state = copy.deepcopy(state)
    for client in getattr(agent, "llmclients", None) or []:
        if hasattr(client, "backend"):
            client.backend.history = []
        if hasattr(client, "last_tools"):
            client.last_tools = ""
    agent.history = state.get("history", [])
    model = state.get("model")
    if model:
        # Per-conversation model; an unconfigured model keeps the current client.
        for i, client in enumerate(getattr(agent, "llmclients", None) or []):
            if getattr(getattr(client, "backend", None), "name", None) == model:
                agent.llmclient = client
                if hasattr(agent, "llm_no"):
                    agent.llm_no = i
                break
    effort = state.get("effort")
    agent.gah_reasoning_effort = effort if effort in EFFORTS else None
    backend = getattr(getattr(agent, "llmclient", None), "backend", None)
    if backend is not None:
        backend.history = state.get("raw", [])
    working = state.get("working", {})
    agent.handler = SimpleNamespace(working=working, code_stop_signal=[]) if working else None
    if hasattr(agent, "all_outputs"):
        agent.all_outputs = []


def settle(messages, status, error=None):
    """Close every unfinished message/turn/tool after a run or service interruption."""
    for message in messages:
        if message.get("status") == "running":
            message["status"] = status
            if error:
                message["error"] = error
        for turn in message.get("turns", []):
            if turn.get("status") == "running":
                turn["status"] = status
            for tool in turn.get("tools", []):
                if tool.get("status") == "running":
                    tool["status"] = status


class Sessions:
    """SQLite conversations. Selection is UI state, never a running task's identity.

    CLI/TUI retain the single-agent busy guard. A run service can enable parallel
    selection and reserve individual sessions instead. Deleted rows are tombstones.
    No API credentials belong in conversation or run records.
    """
    def __init__(self, agent, path):
        self.agent = agent
        self.path = Path(path).expanduser().resolve()
        self.lock = threading.RLock()
        self._ready = False
        self.reserved = False
        self.parallel = False
        self.active = set()
        # Optional scope resolver for root chats: (base, project_id) -> (workspace, project_id).
        # Without it a root chat copies the current chat's scope.
        self.root_scope = None

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

    def _new(self, db, workspace="", project_id="", parent_id="", title="\u65b0\u4f1a\u8bdd"):
        sid = uuid.uuid4().hex
        db.execute("INSERT INTO sessions (id,title,updated,messages,state,deleted,workspace,project_id,parent_id) VALUES (?,?,?,?,?,0,?,?,?)",
                   (sid, title, time.time(), "[]", "{}", workspace, project_id, parent_id))
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
            for column in ("workspace", "project_id", "parent_id"):
                if column not in columns:
                    db.execute(f"ALTER TABLE sessions ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
            db.execute("CREATE INDEX IF NOT EXISTS session_parent ON sessions(parent_id)")
            row = db.execute("SELECT value FROM meta WHERE key='current'").fetchone()
            sid = row[0] if row else None
            if not db.execute("SELECT 1 FROM sessions WHERE id=? AND deleted=0", (sid,)).fetchone():
                self._select(db, self._new(db))
            # Recover all conversations, not only the one selected when the host died.
            for row in db.execute("SELECT id,messages FROM sessions WHERE deleted=0").fetchall():
                messages = json.loads(row["messages"])
                before = copy.deepcopy(messages)
                settle(messages, "interrupted", "Service interrupted; not automatically retried")
                if before != messages:
                    db.execute("UPDATE sessions SET messages=? WHERE id=?", (json.dumps(messages, ensure_ascii=False), row["id"]))
        self._ready = True
        restore(self.agent, self.current()["state"])

    @staticmethod
    def _decode(row):
        if row is None:
            raise ValueError("session not found")
        result = dict(row)
        for key in ("messages", "state"):
            result[key] = json.loads(result[key])
        return result

    def current(self):
        with self.lock:
            self._init()
            with self._db() as db:
                return self._decode(db.execute("SELECT * FROM sessions WHERE id=(SELECT value FROM meta WHERE key='current') AND deleted=0").fetchone())

    def get(self, sid):
        with self.lock:
            self._init()
            with self._db() as db:
                return self._decode(db.execute("SELECT * FROM sessions WHERE id=? AND deleted=0", (sid,)).fetchone())

    def listing(self):
        with self.lock:
            self._init()
            with self._db() as db:
                rows = db.execute("SELECT id,title,updated,workspace,project_id,parent_id FROM sessions WHERE deleted=0 ORDER BY updated DESC,id").fetchall()
            return [dict(row, running=row["id"] in self.active) for row in rows]

    def _write(self, db, current, messages, state):
        title = current["title"]
        if title == "\u65b0\u4f1a\u8bdd":
            first = next((m.get("text", "") for m in messages if m.get("role") == "user"), "")
            title = " ".join(first.split())[:60] or title
        db.execute("UPDATE sessions SET title=?,updated=?,messages=?,state=? WHERE id=?",
                   (title, time.time(), json.dumps(messages, ensure_ascii=False, allow_nan=False),
                    json.dumps(state, ensure_ascii=False, allow_nan=False), current["id"]))

    def save(self, messages):
        """Legacy single-agent API. Background workers must use save_for()."""
        with self.lock:
            self._idle()
            current = self.current()
            if current["id"] in self.active:
                raise RuntimeError("session is running")
            with self._db() as db:
                self._write(db, current, messages, capture(self.agent))

    def remember(self, **values):
        """Persist per-conversation settings (model/effort) without touching the transcript."""
        with self.lock:
            current = self.current()
            if current["id"] in self.active:
                raise RuntimeError("session is running")
            state = dict(current["state"] or {})
            state.update(values)
            with self._db() as db:
                db.execute("UPDATE sessions SET state=? WHERE id=?",
                           (json.dumps(state, ensure_ascii=False, allow_nan=False), current["id"]))

    def save_for(self, sid, messages, state, *, run_id=None):
        """Save an explicitly identified session; never follow UI selection.

        An active session requires its owning run ID, checked against the durable
        record in the same transaction as the write.
        """
        with self.lock:
            current = self.get(sid)
            with self._db() as db:
                if sid in self.active:
                    owner = db.execute("SELECT id FROM runs WHERE session_id=? AND status IN ('running','cancelling')", (sid,)).fetchone()
                    if owner is None or owner[0] != run_id:
                        raise RuntimeError("session is owned by another run")
                self._write(db, current, messages, state)

    def create(self, *, parent_id=None, workspace=None, project_id=None, title=None, select=False):
        """Create a fresh child (or root); a child inherits scope, never history."""
        with self.lock:
            if not self.parallel:
                self._idle()
            base = self.get(parent_id) if parent_id else self.current()
            if title is not None and (not isinstance(title, str) or not title.strip() or len(title.strip()) > 120):
                raise ValueError("title must contain 1-120 characters")
            if parent_id and ((workspace is not None and workspace != base["workspace"]) or
                              (project_id is not None and project_id != base["project_id"])):
                raise ValueError("a child must inherit its parent's workspace and project")
            if not parent_id and workspace is None and self.root_scope:
                workspace, project_id = self.root_scope(base, project_id)
            with self._db() as db:
                sid = self._new(db, base["workspace"] if workspace is None else workspace,
                                base["project_id"] if project_id is None else project_id,
                                parent_id or "", title.strip() if title else "\u65b0\u4f1a\u8bdd")
                if select:
                    self._select(db, sid)
            selected = self.get(sid)
            if select:
                restore(self.agent, selected["state"])
            return selected

    def change(self, action, sid=None, title=None, *, workspace=None, project_id=None, parent_id=None):
        with self.lock:
            if not self.parallel:
                self._idle()
            if action == "new":
                return self.create(parent_id=parent_id, workspace=workspace, project_id=project_id, title=title, select=True)
            current = self.current()
            if action not in ("select", "rename", "delete"):
                raise ValueError("unknown session action")
            self.get(sid)
            fallback = (current["workspace"], current["project_id"])
            if action == "delete" and self.root_scope:
                fallback = self.root_scope(current, None)
            if action == "delete" and sid in self.active:
                raise RuntimeError("cancel the session's run before deleting it")
            with self._db() as db:
                if action == "rename":
                    if not isinstance(title, str) or not title.strip() or len(title.strip()) > 120:
                        raise ValueError("title must contain 1-120 characters")
                    db.execute("UPDATE sessions SET title=? WHERE id=?", (title.strip(), sid))
                elif action == "delete":
                    db.execute("UPDATE sessions SET deleted=1 WHERE id=?", (sid,))
                    if sid == current["id"]:
                        self._select(db, self._new(db, *fallback))
                else:
                    self._select(db, sid)
            selected = self.current()
            if selected["id"] != current["id"]:
                restore(self.agent, selected["state"])
            return selected
