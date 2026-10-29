"""Frontend-neutral bridge between external chat platforms and runs.

An *adapter* connects one platform (Telegram, Feishu, ...). The hub owns
everything platform-neutral: chat -> session binding, commands, run start,
reply extraction, splitting and ordered delivery. See CHANNELS.md.
"""
from __future__ import annotations

import io
import os
import queue
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from . import uploads

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


# GA's chat-frontend convention for returning files (see GA frontends/chatapp_common.py).
FILE_HINT = "If you need to send a file or image to the user, put [FILE:<absolute path>] in your reply."
_FILE_TAG = re.compile(r"\[FILE:([^\]]+)\]")
MAX_SEND_FILE = 50 << 20


def extract_files(text):
    """Split ``[FILE:path]`` tags out of a reply: (clean text, [paths])."""
    paths = [p.strip().strip('"\'') for p in _FILE_TAG.findall(text or "")]
    return _FILE_TAG.sub("", text or "").strip(), [p for p in paths if p]


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
    Inbound: call ``hub.receive(self.name, chat_id, text, user=..., files=...)``
    for each platform message; ``files`` is a list of ``{"name", "data", "mime"}``
    (``data`` = bytes). Outbound: the hub calls ``send(chat_id, text)`` from
    its delivery thread, already split to ``max_len``, and ``send_file(chat_id,
    path)`` for each ``[FILE:path]`` in a reply (override to support files).
    """
    name = "adapter"
    max_len = 4000

    def start(self, hub):
        self.hub = hub

    def stop(self):
        pass

    def send(self, chat_id, text):
        raise NotImplementedError

    def send_file(self, chat_id, path):
        raise NotImplementedError("this channel cannot send files")


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

    def receive(self, channel, chat, text, *, user=None, files=None):
        """Handle one inbound message. Never raises; problems are replied."""
        chat = str(chat)
        text = (text or "").strip()
        files = [f for f in files or [] if isinstance(f, dict) and f.get("data")]
        if not text and not files:
            return None
        try:
            if text.startswith("/") and not files:
                reply = self.command(channel, chat, text)
                if reply is not None:
                    self.reply(channel, chat, reply)
                    return None
            sid = self.session_for(channel, chat)
            if self.runs.active_for(sid):
                self.reply(channel, chat, "Still working on the previous task. Send /stop to cancel it.")
                return None
            attachments = [self._store(f) for f in files[:uploads.MAX_FILES]]
            task = (text + "\n\n" if text else "") + f"({FILE_HINT})"
            run = self.runs.start(task, session_id=sid, source=f"channel:{channel}",
                                  attachments=attachments)
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
    @staticmethod
    def _store(f):
        data = bytes(f["data"])
        d = uploads.save(io.BytesIO(data), len(data), f.get("name") or "file", f.get("mime"))
        return {"url": d["url"], "mime": d["mime"]}

    def on_run_finished(self, envelope):
        """Kernel ``run.finished`` subscriber: deliver the answer to its chat."""
        run = (envelope or {}).get("run") or {}
        source = run.get("source") or ""
        if not source.startswith("channel:"):
            return
        channel = source.split(":", 1)[1]
        text, paths = extract_files(final_text(envelope.get("message")))
        status = run.get("status")
        if not text and not paths:
            text = "(cancelled)" if status == "aborted" else "(no reply)"
        for chat in self.bindings.chats_for(channel, envelope.get("session_id")):
            if text:
                self.reply(channel, chat, text)
            for path in paths:
                self.reply_file(channel, chat, path)

    def reply(self, channel, chat, text):
        """Queue text for a chat; delivery is ordered and off the caller thread."""
        if not self.closed:
            self.outbox.put((channel, str(chat), "text", text))

    def reply_file(self, channel, chat, path):
        """Queue a local file for a chat (sent in order with text replies)."""
        if not self.closed:
            self.outbox.put((channel, str(chat), "file", str(path)))

    def _deliver(self):
        while True:
            item = self.outbox.get()
            if item is None:
                return
            channel, chat, kind, text = item
            adapter = self.adapters.get(channel)
            if adapter is None:
                continue
            if kind == "file":
                self._send_file(adapter, chat, text)
                continue
            for part in split_text(text, max(1, int(getattr(adapter, "max_len", 4000)))):
                try:
                    adapter.send(chat, part)
                except Exception:
                    break  # one failed delivery must not kill the sender thread

    @staticmethod
    def _send_file(adapter, chat, path):
        name = os.path.basename(path) or path
        try:
            if not os.path.isfile(path):
                raise FileNotFoundError("file not found")
            if os.path.getsize(path) > MAX_SEND_FILE:
                raise OverflowError("file too large")
            adapter.send_file(chat, path)
        except Exception as e:
            try:
                adapter.send(chat, f"[file not sent: {name}: {e}]")
            except Exception:
                pass

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
