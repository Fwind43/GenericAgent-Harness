"""Durable conversations, with optional per-session execution reservations."""
from __future__ import annotations

import copy
from contextlib import contextmanager
import hashlib
import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

from . import model_keys, startup


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
    """Close every unfinished message/turn/tool after a run or service interruption.

    Returns whether anything changed.
    """
    changed = False
    for message in messages:
        if message.get("status") == "running":
            message["status"] = status
            changed = True
            if error:
                message["error"] = error
        for turn in message.get("turns", []):
            if turn.get("status") == "running":
                turn["status"] = status
                changed = True
            for tool in turn.get("tools", []):
                if tool.get("status") == "running":
                    tool["status"] = status
                    changed = True
    return changed


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
        if sid and db.execute("SELECT 1 FROM sessions INDEXED BY session_lookup "
                              "WHERE id=? AND deleted=0", (sid,)).fetchone():
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
                   (sid, title, now, "", "{}", workspace, project_id, parent_id, now))
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
            # Transcripts live one row per message: a checkpoint of a long chat rewrites only the
            # messages that changed instead of the whole JSON array. sessions.messages='' marks a
            # migrated chat; a non-empty value is a legacy transcript, migrated on its next write.
            db.execute("CREATE TABLE IF NOT EXISTS session_messages (session_id TEXT NOT NULL, idx INTEGER NOT NULL,"
                       " digest BLOB NOT NULL, body TEXT NOT NULL, head TEXT, PRIMARY KEY (session_id, idx))")
            msg_columns = {r[1] for r in db.execute("PRAGMA table_info(session_messages)")}
            if "head" not in msg_columns:
                db.execute("ALTER TABLE session_messages ADD COLUMN head TEXT")
            db.execute("CREATE INDEX IF NOT EXISTS session_message_digest ON session_messages (session_id, idx, digest)")
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
            # A primary-key lookup still visits the wide table row. Keep light per-chat
            # reads off transcript/state overflow pages, including on existing databases.
            db.execute("CREATE INDEX IF NOT EXISTS session_lookup ON sessions "
                       "(id,deleted,title,updated,workspace,project_id,parent_id,pinned,read_at)")
            row = db.execute("SELECT value FROM meta WHERE key='current'").fetchone()
            sid = row[0] if row else None
            if not db.execute("SELECT 1 FROM sessions WHERE id=? AND deleted=0", (sid,)).fetchone():
                self._select(db, self._new(db))
            # Recover all conversations, not only the one selected when the host died.
            self._recover(db)
        self._ready = True
        restore(self.agent, self.current()["state"])

    @classmethod
    def _recover(cls, db):
        """Mark work left "running" by a dead host as interrupted.

        Every JSON encoding of a "running" status contains the token "running" (quotes
        included), so SQLite skips the other transcripts without Python decoding them: a cold
        start over hundreds of MB of history must not parse it all (issue #2). A false hit (the
        token elsewhere) only costs one decode. Long recoveries report startup progress so a
        supervising shell does not take them for a hang.
        """
        rows = db.execute("SELECT id FROM sessions WHERE deleted=0 AND instr(messages, '\"running\"')>0"
                          " UNION SELECT s.id FROM sessions s JOIN session_messages m ON m.session_id=s.id"
                          " WHERE s.deleted=0 AND instr(m.body, '\"running\"')>0").fetchall()
        total, last = len(rows), time.monotonic()
        for i, (sid,) in enumerate(rows, 1):
            try:
                messages = cls._load(db, sid)
            except ValueError:
                continue
            if settle(messages, "interrupted", "Service interrupted; not automatically retried"):
                cls._store_messages(db, sid, cls._bodies(messages))
            if time.monotonic() - last >= 2:
                last = time.monotonic()
                startup.progress("sessions", f"recover {i}/{total}")

    OUTLINE_TEXT = 200

    @classmethod
    def _clip(cls, text):
        return text[:cls.OUTLINE_TEXT] if isinstance(text, str) and len(text) > cls.OUTLINE_TEXT else text

    @classmethod
    def _head_turn(cls, turn):
        if not isinstance(turn, dict):
            return turn
        out = {k: v for k, v in turn.items() if k not in ("thinking", "prompt", "tools")}
        for key in ("summary", "reply"):
            if key in out:
                out[key] = cls._clip(out[key])
        tools = turn.get("tools")
        if isinstance(tools, list):
            out["tools"] = [
                {k: v for k, v in t.items() if k not in ("data", "args", "data_lazy", "data_chars")}
                if isinstance(t, dict) else t for t in tools
            ]
        return out

    @classmethod
    def _head_json(cls, message):
        """Compact JSON for an older message row, or None when body itself is already light.

        Keeps top-level fields (including full ``text`` so worldline hashes stay exact) while
        stripping heavy turn payloads and marking ``partial=True``.
        """
        if not isinstance(message, dict) or not isinstance(message.get("turns"), list) or not message["turns"]:
            return None
        out = dict(message, partial=True)
        out["turns"] = [cls._head_turn(t) for t in message["turns"]]
        return json.dumps(out, ensure_ascii=False, allow_nan=False)

    @staticmethod
    def _reject_partial(messages):
        if any(isinstance(m, dict) and m.get("partial") for m in messages):
            raise ValueError("cannot persist partial message outlines")

    @classmethod
    def _bodies(cls, messages):
        cls._reject_partial(messages)
        return [json.dumps(m, ensure_ascii=False, allow_nan=False) for m in messages]

    @staticmethod
    def _digest(body):
        return hashlib.blake2b(body.encode("utf-8", "surrogatepass"), digest_size=8).digest()

    @staticmethod
    def _joined(db, sid, legacy=None, *, tail=None):
        """One chat's transcript as JSON text: the legacy column while set, else its message rows.

        When ``tail`` is an integer, only the newest ``tail`` rows read full ``body``; earlier rows
        prefer the compact ``head`` column (falling back to ``body`` when NULL).
        """
        if legacy is None:
            row = db.execute("SELECT messages FROM sessions WHERE id=?", (sid,)).fetchone()
            legacy = row[0] if row is not None else ""
        if legacy:
            return legacy
        if tail is None:
            rows = db.execute("SELECT body FROM session_messages WHERE session_id=? ORDER BY idx", (sid,))
        else:
            keep = max(0, int(tail))
            if keep == 0:
                rows = db.execute(
                    "SELECT COALESCE(head, body) FROM session_messages WHERE session_id=? ORDER BY idx",
                    (sid,),
                )
            else:
                count = db.execute("SELECT COUNT(*) FROM session_messages WHERE session_id=?", (sid,)).fetchone()[0]
                cut = count - keep
                if cut <= 0:
                    rows = db.execute("SELECT body FROM session_messages WHERE session_id=? ORDER BY idx", (sid,))
                else:
                    rows = db.execute(
                        "SELECT CASE WHEN idx < ? THEN COALESCE(head, body) ELSE body END "
                        "FROM session_messages WHERE session_id=? ORDER BY idx",
                        (cut, sid),
                    )
        return "[" + ",".join(r[0] for r in rows) + "]"

    @classmethod
    def _load(cls, db, sid, legacy=None, *, tail=None):
        return json.loads(cls._joined(db, sid, legacy, tail=tail))

    @classmethod
    def _store_messages(cls, db, sid, bodies, digests=None, heads=None, messages=None):
        """Store a transcript as one row per message, writing only rows whose content changed.

        Unchanged messages cost an 8-byte digest read (covered by session_message_digest), so a
        checkpoint of a long chat whose tail grows no longer rewrites the whole history.
        """
        if messages is not None:
            cls._reject_partial(messages)
        old = dict(db.execute("SELECT idx, digest FROM session_messages WHERE session_id=?", (sid,)).fetchall())
        rows = []
        for i, body in enumerate(bodies):
            digest = digests[i] if digests is not None else cls._digest(body)
            if old.get(i) != digest:
                if heads is not None:
                    head = heads[i]
                elif messages is not None:
                    head = cls._head_json(messages[i])
                else:
                    head = None
                rows.append((sid, i, digest, body, head))
        if rows:
            db.executemany(
                "INSERT OR REPLACE INTO session_messages (session_id,idx,digest,body,head) VALUES (?,?,?,?,?)",
                rows,
            )
        if old and max(old) >= len(bodies):
            db.execute("DELETE FROM session_messages WHERE session_id=? AND idx>=?", (sid, len(bodies)))
        db.execute("UPDATE sessions SET messages='' WHERE id=? AND messages<>''", (sid,))

    @staticmethod
    def _blank(db, sid, legacy):
        """True when a chat has no transcript yet, in either storage form, without decoding it."""
        if legacy:
            return legacy.strip() == "[]"
        return db.execute("SELECT 1 FROM session_messages WHERE session_id=? LIMIT 1", (sid,)).fetchone() is None

    @classmethod
    def _decode(cls, row, db=None, *, tail=None):
        """Row -> dict; a migrated transcript is read from session_messages through ``db``."""
        if row is None:
            raise ValueError("session not found")
        result = dict(row)
        if "messages" in result:
            legacy = result["messages"]
            if not legacy and db is None:
                raise RuntimeError("decoding a migrated transcript needs the open connection")
            result["messages"] = json.loads(legacy) if legacy else cls._load(db, result["id"], legacy, tail=tail)
        if "state" in result:
            result["state"] = json.loads(result["state"])
        return result

    # Scalar columns only: skips parsing the (possibly huge) transcript and agent state.
    LIGHT = "id,title,updated,workspace,project_id,parent_id,pinned,read_at,deleted"

    def current(self, light=False, *, tail=None):
        with self.lock:
            self._init()
            cols = self.LIGHT if light else "*"
            table = "sessions INDEXED BY session_lookup" if light else "sessions"
            with self._db() as db:
                return self._decode(db.execute(f"SELECT {cols} FROM {table} WHERE id=? AND deleted=0",
                                               (self._current_id(db),)).fetchone(), db, tail=tail)

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

    def get(self, sid, light=False, *, tail=None):
        with self.lock:
            self._init()
            cols = self.LIGHT if light else "*"
            table = "sessions INDEXED BY session_lookup" if light else "sessions"
            with self._db() as db:
                return self._decode(db.execute(f"SELECT {cols} FROM {table} WHERE id=? AND deleted=0", (sid,)).fetchone(), db, tail=tail)

    def message_range(self, sid, start, end):
        """Return (total_count, full_messages[start:end]) for one live chat."""
        start = max(0, int(start))
        end = max(start, int(end))
        with self.lock:
            self._init()
            with self._db() as db:
                row = db.execute("SELECT messages FROM sessions WHERE id=? AND deleted=0", (sid,)).fetchone()
                if row is None:
                    raise ValueError("session not found")
                legacy = row["messages"]
                if legacy:
                    text = legacy
                    total = None
                else:
                    total = db.execute("SELECT COUNT(*) FROM session_messages WHERE session_id=?", (sid,)).fetchone()[0]
                    rows = db.execute(
                        "SELECT body FROM session_messages WHERE session_id=? AND idx>=? AND idx<? ORDER BY idx",
                        (sid, start, end),
                    ).fetchall()
                    text = "[" + ",".join(r[0] for r in rows) + "]"
        if total is None:
            all_msgs = json.loads(text)
            return len(all_msgs), all_msgs[start:end]
        return total, json.loads(text)

    def message_at(self, sid, index):
        """Return one full message by 0-based index, or None if out of range."""
        index = int(index)
        with self.lock:
            self._init()
            with self._db() as db:
                row = db.execute("SELECT messages FROM sessions WHERE id=? AND deleted=0", (sid,)).fetchone()
                if row is None:
                    raise ValueError("session not found")
                legacy = row["messages"]
                if legacy:
                    text = legacy
                    single = False
                else:
                    if index < 0:
                        return None
                    mrow = db.execute(
                        "SELECT body FROM session_messages WHERE session_id=? AND idx=?",
                        (sid, index),
                    ).fetchone()
                    if mrow is None:
                        return None
                    text = mrow[0]
                    single = True
        if single:
            return json.loads(text)
        all_msgs = json.loads(text)
        return all_msgs[index] if 0 <= index < len(all_msgs) else None

    def state_of(self, sid):
        """Agent state of one chat, without reading or parsing its transcript."""
        with self.lock:
            self._init()
            with self._db() as db:
                row = db.execute("SELECT state FROM sessions WHERE id=? AND deleted=0", (sid,)).fetchone()
        if row is None:
            raise ValueError("session not found")
        return json.loads(row["state"])

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
                rows = [(row["id"], row["title"], row["updated"], self._joined(db, row["id"], row["messages"]))
                        for row in db.execute("SELECT id,title,updated,messages FROM sessions WHERE deleted=0").fetchall()]
        result = []
        for sid, title, updated, text in rows:
            try:
                messages = json.loads(text)
            except ValueError:
                messages = []
            result.append({"id": sid, "title": title, "updated": updated, "messages": messages})
        return result

    def transcript(self, sid):
        """Read-only (id, title, updated, messages) of one live chat, or None.

        Reports over many chats should walk listing() and call this per chat: the store lock
        is held only for one row, and the JSON is decoded outside it.
        """
        with self.lock:
            self._init()
            with self._db() as db:
                row = db.execute("SELECT id,title,updated,messages FROM sessions WHERE id=? AND deleted=0", (sid,)).fetchone()
                text = self._joined(db, sid, row["messages"]) if row is not None else ""
        if row is None:
            return None
        try:
            messages = json.loads(text)
        except ValueError:
            messages = []
        return {"id": row["id"], "title": row["title"], "updated": row["updated"], "messages": messages}

    def _write(self, db, current, messages, state, *, encoded=None):
        # ``encoded`` is an optional pre-serialized (message_bodies, state_json[, digests[, heads]])
        # tuple: run checkpoints pass it so a long transcript is not re-encoded on every flush. A
        # legacy (messages_json, state_json) pair is still accepted; its messages are re-encoded per row.
        self._reject_partial(messages)
        title = current["title"]
        if title == "\u65b0\u4f1a\u8bdd":
            first = next((m.get("text", "") for m in messages if m.get("role") == "user"), "")
            title = " ".join(first.split())[:60] or title
        # A write to the chat on screen is seen as it happens; any other chat becomes unread.
        now = time.time()
        # A None title (run checkpoints) keeps the stored one, so callers need not re-read the row.
        if encoded and not isinstance(encoded[0], str):
            bodies, state_json = encoded[0], encoded[1]
            digests = encoded[2] if len(encoded) > 2 else None
            heads = encoded[3] if len(encoded) > 3 else None
        else:
            bodies, digests, heads = self._bodies(messages), None, None
            state_json = encoded[1] if encoded else json.dumps(state, ensure_ascii=False, allow_nan=False)
        db.execute("UPDATE sessions SET title=COALESCE(?,title),updated=?,state=?,"
                   "read_at=CASE WHEN id=(SELECT value FROM meta WHERE key='current') THEN ? ELSE read_at END WHERE id=?",
                   (title, now, state_json, now, current["id"]))
        self._store_messages(db, current["id"], bodies, digests, heads=heads, messages=messages)

    def save(self, messages):
        """Legacy single-agent API. Background workers must use save_for()."""
        with self.lock:
            self._idle()
            self._reject_partial(messages)
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
                           " VALUES (?,?,?,'',?,0,?,?,'',?,?)",
                           (sid, title or "\u65b0\u4f1a\u8bdd", float(updated),
                            json.dumps(state, ensure_ascii=False, allow_nan=False),
                            workspace or "", project_id or "", float(pinned or 0), float(updated)))
                self._store_messages(db, sid, self._bodies(messages), messages=messages)
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

    def change(self, action, sid=None, title=None, *, workspace=None, project_id=None, parent_id=None, tail=None):
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
            selected = self.current(tail=tail)
            if selected["id"] != current["id"]:
                restore(self.agent, selected["state"])
            return selected
