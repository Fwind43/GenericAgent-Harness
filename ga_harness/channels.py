"""Frontend-neutral bridge between external chat platforms and runs.

An *adapter* connects one platform (Telegram, Feishu, ...). The hub owns
everything platform-neutral: chat -> session binding, commands, run start,
reply extraction, splitting and ordered delivery. See CHANNELS.md.
"""
from __future__ import annotations

import queue
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

HELP = ("/new  start a fresh conversation\n"
        "/stop  cancel the running task\n"
        "/status  show the bound session\n"
        "/help  show this help")


def final_text(message):
    """Return the user-facing answer of a finished assistant message."""
    if not isinstance(message, dict):
        return ""
    for turn in reversed(message.get("turns") or []):
        reply = (turn.get("reply") or "").strip()
        if reply:
            return reply
    text = (message.get("text") or "").strip()
    if message.get("error") and not text:
        return f"[error] {message['error']}"
    return text


def split_text(text, limit):
    """Split on line boundaries where possible; never exceed ``limit``."""
    text, out = text or "", []
    while len(text) > limit:
        cut = text.rfind("\n", 0, limit)
        cut = cut if cut > limit // 2 else limit
        out.append(text[:cut])
        text = text[cut:].lstrip("\n")
    if text:
        out.append(text)
    return out


class Adapter:
    """Base class for one chat platform. Subclass and override.

    Lifecycle: the hub calls ``start(hub)`` once, then ``stop()`` on unload.
    Inbound: call ``hub.receive(self.name, chat_id, text, user=...)`` for each
    platform message. Outbound: the hub calls ``send(chat_id, text)`` from
    its delivery thread, already split to ``max_len``.
    """
    name = "adapter"
    max_len = 4000

    def start(self, hub):
        self.hub = hub

    def stop(self):
        pass

    def send(self, chat_id, text):
        raise NotImplementedError


class Bindings:
    """Durable (channel, chat_id) -> session_id mapping."""

    def __init__(self, path):
        self.path = Path(path)
        with self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS bindings (channel TEXT, chat TEXT,"
                       " session_id TEXT, updated REAL, PRIMARY KEY (channel, chat))")

    @contextmanager
    def _db(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self, channel, chat):
        with self._db() as db:
            row = db.execute("SELECT session_id FROM bindings WHERE channel=? AND chat=?",
                             (channel, str(chat))).fetchone()
        return row[0] if row else None

    def set(self, channel, chat, sid):
        with self._db() as db:
            db.execute("INSERT OR REPLACE INTO bindings VALUES (?,?,?,?)",
                       (channel, str(chat), sid, time.time()))

    def all(self):
        with self._db() as db:
            rows = db.execute("SELECT channel, chat, session_id, updated FROM bindings"
                              " ORDER BY updated DESC").fetchall()
        return [dict(zip(("channel", "chat", "session_id", "updated"), r)) for r in rows]

    def chats_for(self, channel, sid):
        with self._db() as db:
            rows = db.execute("SELECT chat FROM bindings WHERE channel=? AND session_id=?",
                              (channel, sid)).fetchall()
        return [r[0] for r in rows]


class Hub:
    """Platform-neutral router. Published as the ``channels`` service."""

    def __init__(self, runs, sessions, bindings, *, workspace=None, title_prefix="channel"):
        self.runs, self.sessions, self.bindings = runs, sessions, bindings
        self.workspace, self.title_prefix = workspace, title_prefix
        self.adapters = {}
        self.lock = threading.RLock()
        self.outbox = queue.Queue()
        self.closed = False
        self.sender = threading.Thread(target=self._deliver, name="channels-out", daemon=True)
        self.sender.start()

    # -- adapter registry -------------------------------------------------
    def register(self, adapter):
        """Attach an adapter; returns a disposer that detaches it."""
        name = getattr(adapter, "name", "")
        if not isinstance(name, str) or not name or ":" in name or len(name) > 40:
            raise ValueError(f"invalid adapter name: {name!r}")
        with self.lock:
            if name in self.adapters:
                raise ValueError(f"adapter already registered: {name}")
            self.adapters[name] = adapter
        try:
            adapter.start(self)
        except Exception:
            with self.lock:
                self.adapters.pop(name, None)
            raise

        def dispose():
            with self.lock:
                if self.adapters.get(name) is not adapter:
                    return
                del self.adapters[name]
            try:
                adapter.stop()
            except Exception:
                pass
        return dispose

    # -- inbound ----------------------------------------------------------
    def _new_session(self, channel, chat):
        kw = {"title": f"{self.title_prefix}:{channel}:{chat}"[:80]}
        if self.workspace:
            kw["workspace"] = self.workspace
        session = self.sessions.create(**kw)
        self.bindings.set(channel, chat, session["id"])
        return session["id"]

    def session_for(self, channel, chat):
        sid = self.bindings.get(channel, chat)
        if sid and self.sessions.get(sid):
            return sid
        return self._new_session(channel, chat)

    def receive(self, channel, chat, text, *, user=None):
        """Handle one inbound message. Never raises; problems are replied."""
        chat = str(chat)
        text = (text or "").strip()
        if not text:
            return None
        try:
            if text.startswith("/"):
                reply = self.command(channel, chat, text)
                if reply is not None:
                    self.reply(channel, chat, reply)
                    return None
            sid = self.session_for(channel, chat)
            if self.runs.active_for(sid):
                self.reply(channel, chat, "Still working on the previous task. Send /stop to cancel it.")
                return None
            run = self.runs.start(text, session_id=sid, source=f"channel:{channel}")
            return run["id"]
        except Exception as e:  # adapters must not crash on hub errors
            self.reply(channel, chat, f"[error] {e}")
            return None

    def command(self, channel, chat, text):
        """Return a reply for a known command, or None to treat as a prompt."""
        word = text.split()[0].lower().split("@")[0]
        if word == "/help":
            return HELP
        if word == "/new":
            self._new_session(channel, chat)
            return "Started a new conversation."
        if word == "/stop":
            sid = self.bindings.get(channel, chat)
            run = sid and self.runs.active_for(sid)
            if not run:
                return "Nothing is running."
            self.runs.cancel(run["id"])
            return "Cancelling."
        if word == "/status":
            sid = self.bindings.get(channel, chat)
            if not sid:
                return "No conversation yet."
            busy = "running" if self.runs.active_for(sid) else "idle"
            return f"session {sid} ({busy})"
        return None

    # -- outbound ---------------------------------------------------------
    def on_run_finished(self, envelope):
        """Kernel ``run.finished`` subscriber: deliver the answer to its chat."""
        run = (envelope or {}).get("run") or {}
        source = run.get("source") or ""
        if not source.startswith("channel:"):
            return
        channel = source.split(":", 1)[1]
        text = final_text(envelope.get("message"))
        status = run.get("status")
        if not text:
            text = "(cancelled)" if status == "aborted" else "(no reply)"
        for chat in self.bindings.chats_for(channel, envelope.get("session_id")):
            self.reply(channel, chat, text)

    def reply(self, channel, chat, text):
        """Queue text for a chat; delivery is ordered and off the caller thread."""
        if not self.closed:
            self.outbox.put((channel, str(chat), text))

    def _deliver(self):
        while True:
            item = self.outbox.get()
            if item is None:
                return
            channel, chat, text = item
            adapter = self.adapters.get(channel)
            if adapter is None:
                continue
            for part in split_text(text, max(1, int(getattr(adapter, "max_len", 4000)))):
                try:
                    adapter.send(chat, part)
                except Exception:
                    break  # one failed delivery must not kill the sender thread

    def status(self):
        with self.lock:
            names = sorted(self.adapters)
        return {"adapters": names, "bindings": self.bindings.all()}

    def close(self):
        with self.lock:
            adapters, self.adapters = list(self.adapters.values()), {}
        for adapter in adapters:
            try:
                adapter.stop()
            except Exception:
                pass
        self.closed = True
        self.outbox.put(None)
        self.sender.join(timeout=5)
