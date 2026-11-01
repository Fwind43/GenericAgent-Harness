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
from .sessions import EFFORTS

HELP = ("/new  start a fresh conversation (keeps model and effort)\n"
        "/stop  cancel the running task\n"
        "/status  show session, model and effort\n"
        "/model  list models; /model <n|name> switches this chat (alias /llm)\n"
        "/effort  show effort; /effort <low|medium|high|xhigh|max|default> sets it\n"
        "/help  show this help")
BUSY = "Still working on the previous task. Send /stop to cancel it."
# Durable per-turn events forwarded to adapters that implement ``progress``;
# high-frequency stream fragments (assistant.delta) are never forwarded.
PROGRESS_EVENTS = frozenset({"turn.start", "assistant.text", "tool.call", "tool.result", "turn.end"})


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

    Optional rich rendering: an adapter defining ``progress(chat_id, run_id,
    name, data)`` receives durable per-turn run events (``PROGRESS_EVENTS``),
    and one defining ``finish(chat_id, run_id, text, status, error)`` renders
    the final answer itself; if ``finish`` raises, the hub falls back to
    plain ``send``.
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

    def __init__(self, runs, sessions, bindings, *, workspace=None, title_prefix="channel",
                 models=None):
        self.runs, self.sessions, self.bindings = runs, sessions, bindings
        self.workspace, self.title_prefix = workspace, title_prefix
        self.models = models  # model catalog service, or a zero-arg callable returning it
        self.adapters = {}
        self.run_channels = {}  # run_id -> channel name or None (progress routing cache)
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
    def _models(self):
        """The model catalog service, or None when model-store is not loaded."""
        models = self.models
        if models is not None and not hasattr(models, "catalog"):
            try:
                models = models()
            except Exception:
                return None
        return models if hasattr(models, "catalog") else None

    def _session(self, sid):
        """sessions.get() that maps a missing (e.g. deleted) session to None."""
        if not sid:
            return None
        try:
            return self.sessions.get(sid)
        except ValueError:
            return None

    @staticmethod
    def _selection(session):
        """The model/effort explicitly stored on a session."""
        state = (session or {}).get("state") or {}
        return {k: state[k] for k in ("model", "effort") if k in state}

    def _new_session(self, channel, chat, selection=None):
        kw = {"title": f"{self.title_prefix}:{channel}:{chat}"[:80]}
        if self.workspace:
            kw["workspace"] = self.workspace
        session = self.sessions.create(**kw)
        self.bindings.set(channel, chat, session["id"])
        if selection:
            self.sessions.remember_for(session["id"], **selection)
        return session["id"]

    def session_for(self, channel, chat):
        sid = self.bindings.get(channel, chat)
        if self._session(sid):
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
                self.reply(channel, chat, BUSY)
                return None
            stale = self._stale_model(sid)
            if stale:
                note = (f"Model {stale} is no longer configured. Pick another with /model, "
                        "or send /new to use the default.")
                self.reply(channel, chat, note)
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
        parts = text.split(None, 1)
        word = parts[0].lower().split("@")[0]
        arg = parts[1].strip() if len(parts) > 1 else ""
        if word == "/help":
            return HELP
        if word == "/new":
            old = self._session(self.bindings.get(channel, chat))
            keep = self._selection(old)
            names = [m.get("name") for m in self._catalog()[0]]
            note = ""
            if names and keep.get("model") and keep["model"] not in names:
                # Removed from the model config since it was picked: fall back to the default.
                note = f" Model {keep.pop('model')} is no longer configured; using the default."
            self._new_session(channel, chat, keep)
            return "Started a new conversation." + note
        if word in ("/model", "/llm"):
            return self._cmd_model(channel, chat, arg)
        if word == "/effort":
            return self._cmd_effort(channel, chat, arg)
        if word == "/stop":
            sid = self.bindings.get(channel, chat)
            run = sid and self.runs.active_for(sid)
            if not run:
                return "Nothing is running."
            self.runs.cancel(run["id"])
            return "Cancelling."
        if word == "/status":
            sid = self.bindings.get(channel, chat)
            session = self._session(sid)
            if not session:
                return "No conversation yet."
            busy = "running" if self.runs.active_for(sid) else "idle"
            return f"session {sid} ({busy})\n{self._describe(session)}"
        return None

    # -- per-chat model / effort ------------------------------------------
    def _catalog(self):
        """(items, host current id) from model-store; ([], None) without it."""
        models = self._models()
        data = (models.catalog() if models is not None else None) or {}
        return list(data.get("items") or []), data.get("current")

    def _stale_model(self, sid):
        """The session's model if the catalog no longer lists it, else None."""
        model = ((self._session(sid) or {}).get("state") or {}).get("model")
        if not model:
            return None
        try:
            items, _ = self._catalog()
        except Exception:  # no usable catalog: leave the decision to the run
            return None
        return model if items and model not in [m.get("name") for m in items] else None

    def _labels(self, session):
        """(model, effort) of a session as shown to the chat user."""
        state = (session or {}).get("state") or {}
        items, current = self._catalog()
        model = state.get("model")
        if model and items and model not in [m.get("name") for m in items]:
            model += " (no longer configured; pick another with /model)"
        elif not model:
            host = next((m.get("name") for m in items if m.get("id") == current), None)
            model = f"{host} (host default)" if host else "host default"
        effort = (state["effort"] or "default") if "effort" in state else "host setting"
        return model, effort

    def _describe(self, session):
        return "model: {}\neffort: {}".format(*self._labels(session))

    def _busy(self, sid):
        """Refusal while a run is active; settings only change between runs."""
        if self.runs.active_for(sid):
            return ("Still working on the previous task; change settings after it "
                    "finishes. Send /stop to cancel it.")
        return None

    def _cmd_effort(self, channel, chat, arg):
        options = ", ".join([*EFFORTS, "default"])
        if not arg:
            session = self._session(self.bindings.get(channel, chat))
            return f"effort: {self._labels(session)[1]}\noptions: {options}"
        value = arg.lower()
        if value in ("default", "reset", "clear"):  # drop this chat's override
            value = "default"
        elif value not in EFFORTS:
            return f"Unknown effort '{arg}'. Options: {options}"
        sid = self.session_for(channel, chat)
        busy = self._busy(sid)
        if busy:
            return busy
        self.sessions.remember_for(sid, effort=None if value == "default" else value)
        return f"Effort for this chat: {value}."

    def _cmd_model(self, channel, chat, arg):
        items, current = self._catalog()
        if not items:
            return "Model switching is unavailable: the model catalog is not loaded."
        if not arg:
            session = self._session(self.bindings.get(channel, chat))
            chosen = ((session or {}).get("state") or {}).get("model")
            if not chosen:
                chosen = next((m.get("name") for m in items if m.get("id") == current), None)
            rows = [("-> " if m.get("name") == chosen else "   ") + f"[{m.get('id')}] {m.get('name')}"
                    + (f" ({m['provider']})" if m.get("provider") else "") for m in items]
            return "\n".join([f"model: {self._labels(session)[0]}", *rows,
                              "Switch with /model <number|name>."])
        item, error = self._pick(items, arg)
        if error:
            return error
        sid = self.session_for(channel, chat)
        busy = self._busy(sid)
        if busy:
            return busy
        self.sessions.remember_for(sid, model=item["name"])
        return f"Model for this chat: [{item['id']}] {item['name']}."

    @staticmethod
    def _pick(items, arg):
        """(item, None) for a catalog id or a unique name/model match, else (None, error)."""
        key = arg.casefold()

        def text(m, k):
            return str(m.get(k) or "").casefold()
        if arg.isascii() and arg.isdigit():  # a bare number is always a catalog id
            hit = [m for m in items if m.get("id") == int(arg)]
            if not hit:
                return None, f"No model number {arg}. Send /model to see the list."
            return hit[0], None
        tests = (lambda m: text(m, "name") == key,
                 lambda m: text(m, "model") == key,
                 lambda m: key in text(m, "name") or key in text(m, "model"))
        for test in tests:
            hit = [m for m in items if test(m)]
            if hit:
                break
        if len(hit) == 1:
            return hit[0], None
        if not hit:
            return None, f"Unknown model '{arg}'. Send /model to see the list."
        names = ", ".join(f"[{m.get('id')}] {m.get('name')}" for m in hit[:10])
        return None, f"'{arg}' matches several models: {names}. Pick one by number."

    # -- outbound ---------------------------------------------------------
    @staticmethod
    def _store(f):
        data = bytes(f["data"])
        d = uploads.save(io.BytesIO(data), len(data), f.get("name") or "file", f.get("mime"))
        return {"url": d["url"], "mime": d["mime"]}

    def _run_channel(self, run_id):
        """Channel name of a run started from a chat (cached), else None."""
        with self.lock:
            if run_id in self.run_channels:
                return self.run_channels[run_id]
        try:
            source = self.runs.get(run_id).get("source") or ""
        except Exception:
            return None
        channel = source.split(":", 1)[1] if source.startswith("channel:") else None
        with self.lock:
            self.run_channels[run_id] = channel
            while len(self.run_channels) > 256:
                self.run_channels.pop(next(iter(self.run_channels)))
        return channel

    def on_run_event(self, envelope):
        """Kernel ``run.event`` subscriber: forward turn progress to adapters
        that render it (``adapter.progress``); others only get the final reply."""
        envelope = envelope or {}
        name, run_id = envelope.get("name"), envelope.get("run_id")
        if name not in PROGRESS_EVENTS or not run_id or self.closed:
            return
        channel = self._run_channel(run_id)
        adapter = self.adapters.get(channel) if channel else None
        if adapter is None or not callable(getattr(adapter, "progress", None)):
            return
        data = envelope.get("data") if isinstance(envelope.get("data"), dict) else {}
        for chat in self.bindings.chats_for(channel, envelope.get("session_id")):
            self.outbox.put((channel, str(chat), "progress", (run_id, name, data)))

    def on_run_finished(self, envelope):
        """Kernel ``run.finished`` subscriber: deliver the answer to its chat."""
        run = (envelope or {}).get("run") or {}
        source = run.get("source") or ""
        if not source.startswith("channel:"):
            return
        channel = source.split(":", 1)[1]
        with self.lock:
            self.run_channels.pop(run.get("id"), None)
        text, paths = extract_files(final_text(envelope.get("message")))
        status = run.get("status")
        if not text and not paths:
            text = "(cancelled)" if status == "aborted" else "(no reply)"
        adapter = self.adapters.get(channel)
        rich = adapter is not None and callable(getattr(adapter, "finish", None))
        for chat in self.bindings.chats_for(channel, envelope.get("session_id")):
            if rich and not self.closed:
                self.outbox.put((channel, str(chat), "finish",
                                 (run.get("id"), text, status, run.get("error"))))
            elif text:
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
            if kind == "progress":
                try:
                    adapter.progress(chat, *text)
                except Exception:
                    pass  # progress is best effort; the final reply still follows
                continue
            if kind == "finish":
                run_id, text, status, error = text
                try:
                    adapter.finish(chat, run_id, text, status, error)
                    continue
                except Exception:
                    pass  # fall back to plain text below
                if not text:
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
