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

from . import model_keys


def capture(agent):
    handler = getattr(agent, "handler", None)
    working = getattr(handler, "working", {})
    client = getattr(agent, "llmclient", None)
    backend = getattr(client, "backend", None)   # None before any model exists
    return copy.deepcopy({
        "history": getattr(handler, "history_info", agent.history),
        "raw": getattr(backend, "history", []),
        "working": {k: working[k] for k in ("key_info", "passed_sessions") if k in working},
        "model": getattr(backend, "name", ""),
        "model_key": model_keys.key_of(client),
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
    # Per-conversation model, by mykey.py key (name only for older state); an
    # unconfigured model keeps the current client.
    hit = model_keys.find(getattr(agent, "llmclients", None), state.get("model_key"), state.get("model"))
    if hit:
        i, agent.llmclient = hit
        if hasattr(agent, "llm_no"):
            agent.llm_no = i
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
        # Per-request "chat on screen" (parallel mode only). Each web client names the chat it
        # shows; current() then answers for that client instead of the host-wide selection.
        self._viewer = threading.local()

    def view(self, sid=None):
        """Bind this thread to the chat its client shows; None restores the host-wide selection."""
        ok = self.parallel and isinstance(sid, str) and 0 < len(sid) <= 64
        self._viewer.sid = sid if ok else None

    def _current_id(self, db):
        """Id of this thread's chat: its client's own when still alive, else the host-wide one."""
        sid = getattr(self._viewer, "sid", None)
        if sid and db.execute("SELECT 1 FROM sessions WHERE id=? AND deleted=0", (sid,)).fetchone():
            return sid
        row = db.execute("SELECT value FROM meta WHERE key='current'").fetchone()
        return row[0] if row else None

    @contextmanager
    def _db(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=15000")
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
        now = time.time()
        db.execute("INSERT INTO sessions (id,title,updated,messages,state,deleted,workspace,project_id,parent_id,read_at) VALUES (?,?,?,?,?,0,?,?,?,?)",
                   (sid, title, now, "[]", "{}", workspace, project_id, parent_id, now))
        return sid

    def _select(self, db, sid, view=True):
        # The host-wide selection stays "last chat opened anywhere": the default for a new tab
        # and for callers without a client (CLI, run threads).
        db.execute("INSERT OR REPLACE INTO meta VALUES ('current', ?)", (sid,))
        if view and getattr(self._viewer, "sid", None):
            self._viewer.sid = sid
        # Opening a chat reads it.
        db.execute("UPDATE sessions SET read_at=MAX(read_at,updated,?) WHERE id=?", (time.time(), sid))

    def _init(self):
        if self._ready:
            return
        self._idle()
        with self._db() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=NORMAL")
            db.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated REAL NOT NULL, messages TEXT NOT NULL, state TEXT NOT NULL, deleted INTEGER NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            columns = {r[1] for r in db.execute("PRAGMA table_info(sessions)")}
            for column in ("workspace", "project_id", "parent_id"):
                if column not in columns:
                    db.execute(f"ALTER TABLE sessions ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
            if "pinned" not in columns:   # pin time; 0 = not pinned
                db.execute("ALTER TABLE sessions ADD COLUMN pinned REAL NOT NULL DEFAULT 0")
            if "read_at" not in columns:  # last time the user saw the chat; existing chats start read
                db.execute("ALTER TABLE sessions ADD COLUMN read_at REAL NOT NULL DEFAULT 0")
                db.execute("UPDATE sessions SET read_at=updated")
            db.execute("CREATE INDEX IF NOT EXISTS session_parent ON sessions(parent_id)")
            # Cover the sidebar projection and its ordering without reading transcript/state
            # overflow pages from the wide sessions table. Also migrates existing databases.
            db.execute("CREATE INDEX IF NOT EXISTS session_listing ON sessions "
                       "(deleted,pinned DESC,updated DESC,id,title,workspace,project_id,parent_id,read_at)")
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
            if key in result:
                result[key] = json.loads(result[key])
        return result

    # Scalar columns only: skips parsing the (possibly huge) transcript and agent state.
    LIGHT = "id,title,updated,workspace,project_id,parent_id,pinned,read_at,deleted"

    def current(self, light=False):
        with self.lock:
            self._init()
            cols = self.LIGHT if light else "*"
            with self._db() as db:
                return self._decode(db.execute(f"SELECT {cols} FROM sessions WHERE id=? AND deleted=0",
                                               (self._current_id(db),)).fetchone())

    # Small per-user UI preferences (e.g. sidebar layout) kept next to the chats so every
    # client of this host -- local or remote -- sees the same state. Values are JSON.
    PREF_KEYS = ("sidebar.layout", "sidebar.groups")

    def prefs(self):
        with self.lock, self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            rows = db.execute("SELECT key,value FROM meta WHERE key LIKE 'pref:%'").fetchall()
        out = {}
        for key, value in rows:
            try:
                out[key[5:]] = json.loads(value)
            except ValueError:
                pass
        return out

    def set_pref(self, key, value):
        if key not in self.PREF_KEYS:
            raise ValueError(f"unknown preference: {key}")
        text = json.dumps(value, ensure_ascii=False, allow_nan=False)
        if len(text) > 65536:
            raise ValueError("preference too large")
        with self.lock, self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", ("pref:" + key, text))

    def get(self, sid, light=False):
        with self.lock:
            self._init()
            cols = self.LIGHT if light else "*"
            with self._db() as db:
                return self._decode(db.execute(f"SELECT {cols} FROM sessions WHERE id=? AND deleted=0", (sid,)).fetchone())

    def listing(self):
        with self.lock:
            self._init()
            with self._db() as db:
                rows = db.execute("SELECT id,title,updated,workspace,project_id,parent_id,pinned,read_at FROM sessions WHERE deleted=0 ORDER BY pinned DESC,updated DESC,id").fetchall()
            # Unread = new transcript content since the user last saw it (opened, or watched it being written).
            # Sub-chats (worker runs under a parent) are always treated as read.
            return [dict(row, running=row["id"] in self.active,
                         unread=not row["parent_id"] and row["updated"] > row["read_at"]) for row in rows]

    def transcripts(self):
        """Read-only (id, title, updated, messages) for every live chat, e.g. for usage reports."""
        with self.lock:
            self._init()
            with self._db() as db:
                rows = db.execute("SELECT id,title,updated,messages FROM sessions WHERE deleted=0").fetchall()
        result = []
        for row in rows:
            try:
                messages = json.loads(row["messages"])
            except ValueError:
                messages = []
            result.append({"id": row["id"], "title": row["title"], "updated": row["updated"], "messages": messages})
        return result

    def _write(self, db, current, messages, state):
        title = current["title"]
        if title == "\u65b0\u4f1a\u8bdd":
            first = next((m.get("text", "") for m in messages if m.get("role") == "user"), "")
            title = " ".join(first.split())[:60] or title
        # A write to the chat on screen is seen as it happens; any other chat becomes unread.
        now = time.time()
        # A None title (run checkpoints) keeps the stored one, so callers need not re-read the row.
        db.execute("UPDATE sessions SET title=COALESCE(?,title),updated=?,messages=?,state=?,"
                   "read_at=CASE WHEN id=(SELECT value FROM meta WHERE key='current') THEN ? ELSE read_at END WHERE id=?",
                   (title, now, json.dumps(messages, ensure_ascii=False, allow_nan=False),
                    json.dumps(state, ensure_ascii=False, allow_nan=False), now, current["id"]))

    def save(self, messages):
        """Legacy single-agent API. Background workers must use save_for()."""
        with self.lock:
            self._idle()
            current = self.current()
            if current["id"] in self.active:
                raise RuntimeError("session is running")
            state = {**(current.get("state") or {}), **capture(self.agent)}
            with self._db() as db:
                self._write(db, current, messages, state)

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

    def remember_for(self, sid, **values):
        """remember() for an explicitly identified session (e.g. a channel chat)."""
        with self.lock:
            session = self.get(sid)
            if session["id"] in self.active:
                raise RuntimeError("session is running")
            state = dict(session["state"] or {})
            state.update(values)
            with self._db() as db:
                db.execute("UPDATE sessions SET state=? WHERE id=?",
                           (json.dumps(state, ensure_ascii=False, allow_nan=False), session["id"]))

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

    def insert(self, sid, *, title, messages, state, updated, workspace="", project_id="", pinned=0):
        """Add a finished, unselected chat (e.g. imported history) under a caller-chosen ID.

        Returns False when a live chat already uses the ID; a deleted tombstone is replaced.
        """
        if not isinstance(sid, str) or not sid:
            raise ValueError("session id required")
        with self.lock:
            self._init()
            with self._db() as db:
                row = db.execute("SELECT deleted FROM sessions WHERE id=?", (sid,)).fetchone()
                if row is not None and not row["deleted"]:
                    return False
                db.execute("INSERT OR REPLACE INTO sessions (id,title,updated,messages,state,deleted,workspace,project_id,parent_id,pinned,read_at)"
                           " VALUES (?,?,?,?,?,0,?,?,'',?,?)",
                           (sid, title or "\u65b0\u4f1a\u8bdd", float(updated),
                            json.dumps(messages, ensure_ascii=False, allow_nan=False),
                            json.dumps(state, ensure_ascii=False, allow_nan=False),
                            workspace or "", project_id or "", float(pinned or 0), float(updated)))
            return True

    def exists(self, sid):
        with self.lock:
            self._init()
            with self._db() as db:
                return db.execute("SELECT 1 FROM sessions WHERE id=? AND deleted=0", (sid,)).fetchone() is not None

    def create(self, *, parent_id=None, workspace=None, project_id=None, title=None, select=False):
        """Create a fresh child (or root); a child inherits scope, never history."""
        with self.lock:
            if not self.parallel:
                self._idle()
            base = self.get(parent_id, light=True) if parent_id else self.current(light=True)
            if title is not None and (not isinstance(title, str) or not title.strip() or len(title.strip()) > 120):
                raise ValueError("title must contain 1-120 characters")
            # A child stays in its parent's project; it may run in its own working
            # directory (e.g. a conductor task in a git worktree), validated by the caller.
            if parent_id and project_id is not None and project_id != base["project_id"]:
                raise ValueError("a child must inherit its parent's project")
            # A root chat never inherits the current chat's project: callers that
            # want one (the project group's "+", channels) pass project_id explicitly.
            if not parent_id and project_id is None:
                project_id = ""
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
            current = self.current(light=True)
            if action == "read_all":
                with self._db() as db:
                    db.execute("UPDATE sessions SET read_at=MAX(read_at,updated) WHERE deleted=0")
                return current
            if action not in ("select", "rename", "delete", "pin", "unpin", "read", "unread"):
                raise ValueError("unknown session action")
            self.get(sid, light=True)
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
                elif action in ("pin", "unpin"):
                    # Pinning never changes selection or the transcript's updated time.
                    db.execute("UPDATE sessions SET pinned=? WHERE id=?", (time.time() if action == "pin" else 0, sid))
                elif action in ("read", "unread"):
                    # Never changes selection; "unread" holds until the chat is opened or written while open.
                    db.execute("UPDATE sessions SET read_at=? WHERE id=?",
                               (time.time() if action == "read" else 0, sid))
                elif action == "delete":
                    db.execute("UPDATE sessions SET deleted=1 WHERE id=?", (sid,))
                    # Another client may delete the host-wide selection without showing it;
                    # that must still be repointed, but without moving this client's own view.
                    shown = sid == current["id"]
                    host = db.execute("SELECT value FROM meta WHERE key='current'").fetchone()
                    if shown or (host and host[0] == sid):
                        # Fall back to the next existing top-level chat (same project first, in sidebar
                        # order); only create a fresh one when nothing is left.
                        row = db.execute(
                            "SELECT id FROM sessions WHERE deleted=0 AND parent_id='' "
                            "ORDER BY project_id=? DESC,pinned DESC,updated DESC,id LIMIT 1",
                            (current["project_id"],)).fetchone()
                        self._select(db, row[0] if row else self._new(db, *fallback), view=shown)
                else:
                    self._select(db, sid)
            selected = self.current()
            if selected["id"] != current["id"]:
                restore(self.agent, selected["state"])
            return selected
