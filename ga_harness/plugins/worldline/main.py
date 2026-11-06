"""Conversation worldlines: edit/resend, regenerate and branch switching."""
import hashlib
import json
import logging
import sqlite3
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _hash(messages):
    h = hashlib.sha1()
    for m in messages:
        h.update(json.dumps([m.get("role"), m.get("text", "")], ensure_ascii=False).encode("utf-8"))
        h.update(b"\0")
    return h.hexdigest()


def _user_indexes(messages):
    return [i for i, m in enumerate(messages) if m.get("role") == "user"]


class Store:
    """Branch archive beside the session database.

    checkpoints: agent state captured just before a user message was sent,
    keyed by (session, message index, prefix hash).
    branches: archived full conversations that diverge at a user message.
    """

    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()
        with self._db() as db:
            db.executescript("""
CREATE TABLE IF NOT EXISTS checkpoints(session_id TEXT, idx INTEGER, prefix TEXT, state TEXT,
  PRIMARY KEY(session_id, idx, prefix));
CREATE TABLE IF NOT EXISTS branches(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
  idx INTEGER, prefix TEXT, full TEXT, messages TEXT, state TEXT, created REAL,
  UNIQUE(session_id, full));
""")

    def _db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def checkpoint(self, sid, idx, prefix, state):
        with self.lock, self._db() as db:
            db.execute("INSERT OR IGNORE INTO checkpoints VALUES(?,?,?,?)",
                       (sid, idx, prefix, json.dumps(state, ensure_ascii=False)))

    def state_before(self, sid, idx, prefix):
        with self.lock, self._db() as db:
            row = db.execute("SELECT state FROM checkpoints WHERE session_id=? AND idx=? AND prefix=?",
                             (sid, idx, prefix)).fetchone()
        return None if row is None else json.loads(row[0])

    def archive(self, sid, idx, messages, state):
        """Keep a conversation as a variant at user message ``idx`` (idempotent)."""
        with self.lock, self._db() as db:
            db.execute("INSERT OR IGNORE INTO branches(session_id,idx,prefix,full,messages,state,created) "
                       "VALUES(?,?,?,?,?,?,?)",
                       (sid, idx, _hash(messages[:idx]), _hash(messages),
                        json.dumps(messages, ensure_ascii=False), json.dumps(state, ensure_ascii=False), time.time()))

    def rows(self, sid):
        with self.lock, self._db() as db:
            return [dict(r) for r in db.execute(
                "SELECT id,idx,prefix,full,created FROM branches WHERE session_id=? ORDER BY created,id", (sid,))]

    def origin(self, row):
        """(key, born) of the user message a branch starts with; cached, rows never change."""
        cache = self.__dict__.setdefault("_origins", {})
        if row["id"] not in cache:
            with self.lock, self._db() as db:
                found = db.execute("SELECT messages FROM branches WHERE id=?", (row["id"],)).fetchone()
            try:
                message = json.loads(found[0])[row["idx"]]
            except Exception:
                message = None
            cache[row["id"]] = _origin(message, row)
        return cache[row["id"]]

    def load(self, sid, branch_id):
        with self.lock, self._db() as db:
            row = db.execute("SELECT * FROM branches WHERE session_id=? AND id=?", (sid, branch_id)).fetchone()
        if row is None:
            raise ValueError("branch not found")
        return json.loads(row["messages"]), json.loads(row["state"])

    def copy_checkpoints(self, src, dst, limit):
        """Let a branched session edit/regenerate its inherited messages."""
        with self.lock, self._db() as db:
            db.execute("INSERT OR IGNORE INTO checkpoints SELECT ?,idx,prefix,state FROM checkpoints "
                       "WHERE session_id=? AND idx<?", (dst, src, limit))


def _store_path(sessions):
    base = getattr(sessions, "path", None) or getattr(sessions, "db_path", None)
    return Path(base).with_name("worldline.db") if base else HERE / "worldline.db"


def _origin(message, row=None):
    """Identity and birth time of one variant: the user message sent at the fork point.

    Every send (edit, regenerate) creates a new user message with its own run id and time,
    while switching to or continuing a variant keeps it, so this orders variants stably.
    """
    message = message if isinstance(message, dict) else {}
    born = message.get("created_at")
    key = message.get("run_id") or (f"t:{born}" if born is not None else None)
    if key is None:
        key = f"row:{row['id']}" if row else "live"
    if not isinstance(born, (int, float)):
        born = row["created"] if row else float("inf")
    return key, born


def variants(store, sid, messages):
    """For each user message: every variant at that point, in the order they were first sent.

    ``order`` holds a branch id per variant (``None`` for the live one) and ``current`` is the
    1-based position of the live variant. Older archived snapshots of a variant collapse into
    its latest one, so editing or switching back and forth never reshuffles positions.
    """
    rows, out, full = store.rows(sid), {}, _hash(messages)
    for idx in _user_indexes(messages):
        prefix = _hash(messages[:idx])
        live_key, live_born = _origin(messages[idx])
        slots = {live_key: (live_born, None)}
        for r in rows:  # oldest first, so the latest snapshot of a variant wins
            if r["idx"] != idx or r["prefix"] != prefix or r["full"] == full:
                continue
            key, born = store.origin(r)
            if key == live_key:
                continue
            prev = slots.get(key)
            slots[key] = (min(born, prev[0]) if prev else born, r["id"])
        if len(slots) < 2:
            continue
        ordered = sorted(slots.items(), key=lambda kv: (kv[1][0], str(kv[0])))
        order = [bid for _, (_, bid) in ordered]
        out[str(idx)] = {"order": order, "branches": [b for b in order if b is not None],
                         "count": len(order), "current": order.index(None) + 1}
    return out


# Per-conversation choices made via sessions.remember(); they belong to the conversation, not to
# a point in its history, so rewinding or switching branches must not bring back older ones.
SETTINGS = ("model", "effort", "preset")


def _keep_settings(state, live):
    state, live = dict(state or {}), live or {}
    for key in SETTINGS:
        if key in live:
            state[key] = live[key]
        else:
            state.pop(key, None)
    return state


def apply(ctx, config):
    host, runs, sessions = ctx.get("web.host"), ctx.get("runs"), ctx.get("sessions")
    frontend, store = host.frontend, Store(_store_path(sessions))

    def started(data, nxt=None):
        """Remember the agent state as it was just before this user message."""
        try:
            sid, messages = data.get("session_id"), data.get("messages") or []
            idx = max((i for i in _user_indexes(messages)), default=None)
            if sid and idx is not None:
                store.checkpoint(sid, idx, _hash(messages[:idx]), sessions.get(sid)["state"])
        except Exception:
            logging.getLogger(__name__).exception("worldline checkpoint failed")
        return nxt(data) if nxt else None

    def snapshot(data, nxt):
        sid = data.get("session_id")
        if sid:
            try:
                data["worldline"] = variants(store, sid, data.get("messages") or [])
            except Exception:
                data["worldline"] = {}
        return nxt(data)


    def _refresh(sid, messages):
        """Push the rewritten conversation to the open page."""
        try:
            if sessions.current()["id"] == sid:
                frontend.messages = messages
        except Exception:
            pass
        data = frontend.snapshot()
        frontend._broadcast("snapshot", data)
        return data

    def _session(body):
        sid = (body or {}).get("session_id")
        if not sid:
            raise ValueError("session_id required")
        if runs.active_for(sid):
            raise RuntimeError("wait for the running task to finish")
        return sid, sessions.get(sid)


    def _guard(fn):
        def route(request):
            try:
                with sessions.lock:
                    return fn(request.get("body") or {})
            except ValueError as error:
                return 400, {"error": str(error)}
            except RuntimeError as error:
                return 409, {"error": str(error)}
        return route

    def fork(body):
        """Edit-and-resend (``text`` given) or regenerate a user message."""
        sid, current = _session(body)
        messages, idx = current["messages"], int(body.get("index", -1))
        if not (0 <= idx < len(messages)) or messages[idx].get("role") != "user":
            raise ValueError("index must point at a user message")
        state = store.state_before(sid, idx, _hash(messages[:idx]))
        if state is None:
            raise RuntimeError("no checkpoint for this message; it predates the worldline plugin")
        text = body.get("text")
        text = messages[idx].get("text", "") if text is None else str(text)
        if not text.strip():
            raise ValueError("message is empty")
        store.archive(sid, idx, messages, current["state"])
        with sessions._db() as db:
            sessions._write(db, current, messages[:idx], _keep_settings(state, current["state"]))
        _refresh(sid, messages[:idx])
        run = runs.start(text, session_id=sid, source="worldline")
        return {"ok": True, "run": run}


    def switch(body):
        """Swap the live conversation for an archived branch (the live one is archived first)."""
        sid, current = _session(body)
        branch_id = int(body.get("branch_id", 0))
        row = next((r for r in store.rows(sid) if r["id"] == branch_id), None)
        if row is None:
            raise ValueError("branch not found")
        messages, state = store.load(sid, branch_id)
        live, idx = current["messages"], row["idx"]
        if _hash(live[:idx]) != row["prefix"]:
            raise ValueError("branch does not share this conversation's history")
        store.archive(sid, idx, live, current["state"])
        with sessions._db() as db:
            sessions._write(db, current, messages, _keep_settings(state, current["state"]))
        return _refresh(sid, messages)

    def branch(body):
        """Open a new child session holding the conversation up to the end of this turn."""
        sid, current = _session(body)
        messages, idx = current["messages"], int(body.get("index", -1))
        if not (0 <= idx < len(messages)) or messages[idx].get("role") != "user":
            raise ValueError("index must point at a user message")
        end = next((i for i in _user_indexes(messages) if i > idx), len(messages))
        if end == len(messages):
            state = current["state"]
        else:
            state = store.state_before(sid, end, _hash(messages[:end]))
            if state is None:
                raise RuntimeError("no checkpoint for this message; it predates the worldline plugin")
        kept = messages[:end]
        child = sessions.create(parent_id=sid)
        with sessions._db() as db:
            sessions._write(db, child, kept, _keep_settings(state, current["state"]))
        store.copy_checkpoints(sid, child["id"], end)
        sessions.change("select", child["id"])
        return _refresh(child["id"], kept)

    def listing(body):
        sid = body.get("session_id")
        if not sid:
            raise ValueError("session_id required")
        return {"variants": variants(store, sid, sessions.get(sid)["messages"])}

    ctx.on("run.started", started)
    ctx.on("web.snapshot", snapshot)
    ctx.scope.add(host.register("worldline", script=(HERE / "client.js") if (HERE / "client.js").is_file() else None, style=HERE / "client.css", order=40,
        routes={("POST", "fork"): _guard(fork), ("POST", "switch"): _guard(switch), ("POST", "branch"): _guard(branch),
                ("POST", "list"): _guard(listing)}))
