"""Frontend-neutral bridge between external chat platforms and runs.

An *adapter* connects one platform (Telegram, Feishu, ...). The hub owns
everything platform-neutral: chat -> session binding, commands, run start,
reply extraction, splitting and ordered delivery. See CHANNELS.md.
"""
from __future__ import annotations

import io
import json
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

HELP = ("/new  新建会话（保留当前模型和推理强度）\n"
        "/sessions  列出最近的会话；/sessions <页码> 翻页\n"
        "/use  /use <编号|会话ID> 把本聊天切换到已有会话\n"
        "/projects  列出项目；/project <编号|名称> 切换到该项目，/project none 回到默认\n"
        "/stop  取消正在运行的任务\n"
        "/status  查看当前会话、项目、模型和推理强度\n"
        "/model  列出模型；/model <编号|名称> 切换本聊天的模型（别名 /llm）\n"
        "/effort  查看推理强度；/effort <low|medium|high|xhigh|max|default> 设置\n"
        "/help  显示本帮助")
BUSY = "上一个任务还在运行。发送 /stop 可以取消。"
SESSIONS_PAGE = 10  # rows per /sessions page; numbering is global so /use <n> works from any page
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
                 models=None, workspaces=None):
        self.runs, self.sessions, self.bindings = runs, sessions, bindings
        self.workspace, self.title_prefix = workspace, title_prefix
        self.models = models  # model catalog service, or a zero-arg callable returning it
        self.workspaces = workspaces  # workspace/project service, or a zero-arg callable
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
        return {k: state[k] for k in ("model", "model_key", "effort") if k in state}

    @staticmethod
    def _listed(items, state):
        """Whether the session's stored model is still configured (by key, else name)."""
        key = state.get("model_key")
        if key and any(m.get("key") for m in items):
            return any(m.get("key") == key for m in items)
        return state.get("model") in [m.get("name") for m in items]

    @staticmethod
    def _chosen(items, state, current):
        """Catalog row of the session's model (key first), else the host's current one."""
        key, name = state.get("model_key"), state.get("model")
        for test in ((lambda m: key and m.get("key") == key), (lambda m: not key and name and m.get("name") == name),
                     (lambda m: not name and m.get("id") == current)):
            hit = next((m for m in items if test(m)), None)
            if hit:
                return hit
        return None

    def _workspaces(self):
        """The workspace/project service, or None when workspace-store is not loaded."""
        ws = self.workspaces
        if ws is not None and not hasattr(ws, "projects"):
            try:
                ws = ws()
            except Exception:
                return None
        return ws if hasattr(ws, "projects") else None

    def _new_session(self, channel, chat, selection=None, project_id=""):
        # Always pass the project explicitly: otherwise sessions.create() inherits the
        # project the web UI happens to have selected. A project chat starts in the
        # project's directory (resolved by the session store); the configured channel
        # workspace only applies to chats without a project.
        kw = {"title": f"{self.title_prefix}:{channel}:{chat}"[:80], "project_id": project_id or ""}
        if self.workspace and not project_id:
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
                note = (f"模型 {stale} 已不在配置中。请用 /model 另选一个，"
                        "或发送 /new 使用默认模型。")
                self.reply(channel, chat, note)
                return None
            attachments = [self._store(f) for f in files[:uploads.MAX_FILES]]
            task = (text + "\n\n" if text else "") + f"({FILE_HINT})"
            run = self.runs.start(task, session_id=sid, source=f"channel:{channel}",
                                  attachments=attachments)
            return run["id"]
        except Exception as e:  # adapters must not crash on hub errors
            self.reply(channel, chat, f"[错误] {e}")
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
            items = self._catalog()[0]
            note = ""
            if items and keep.get("model") and not self._listed(items, keep):
                # Removed from the model config since it was picked: fall back to the default.
                keep.pop("model_key", None)
                note = f"模型 {keep.pop('model')} 已不在配置中，改用默认模型。"
            self._new_session(channel, chat, keep, project_id=(old or {}).get("project_id") or "")
            return "已新建会话。" + note
        if word == "/sessions":
            return self._cmd_sessions(channel, chat, arg)
        if word == "/use":
            return self._cmd_use(channel, chat, arg)
        if word in ("/model", "/llm"):
            return self._cmd_model(channel, chat, arg)
        if word == "/effort":
            return self._cmd_effort(channel, chat, arg)
        if word == "/projects":
            return self._cmd_project(channel, chat, "")
        if word == "/project":
            return self._cmd_project(channel, chat, arg)
        if word == "/stop":
            sid = self.bindings.get(channel, chat)
            run = sid and self.runs.active_for(sid)
            if not run:
                return "当前没有正在运行的任务。"
            self.runs.cancel(run["id"])
            return "正在取消。"
        if word == "/status":
            sid = self.bindings.get(channel, chat)
            session = self._session(sid)
            if not session:
                return "还没有会话。"
            busy = "运行中" if self.runs.active_for(sid) else "空闲"
            return (f"会话 {sid}（{busy}）\n标题：{session.get('title') or '-'}\n"
                    f"{self._scope_text(sid, session)}{self._describe(session)}")
        return None

    # -- project switching ------------------------------------------------
    def _scope_text(self, sid, session):
        """'项目/目录' lines for /status; empty without the workspace store."""
        ws = self._workspaces()
        if ws is None:
            return ""
        try:
            ctx = ws.context(sid)
        except Exception as e:
            return f"项目：{session.get('project_id') or '无'}（{e}）\n"
        name = (ctx.get("project") or {}).get("name") or "无"
        return f"项目：{name}\n目录：{ctx.get('workspace') or '-'}\n"

    def _rescope(self, sid, project):
        """Re-file an empty chat under another project in place; False if not possible."""
        ws, store = self._workspaces(), self.sessions
        if ws is None or not hasattr(store, "_db") or not hasattr(store, "lock"):
            return False
        try:
            directory = ws.project_workspace(project) if project else (self.workspace or ws.default_workspace)
            with store.lock, store._db() as db:
                row = db.execute("SELECT messages FROM sessions WHERE id=? AND deleted=0", (sid,)).fetchone()
                if row is None or json.loads(row[0] or "[]"):
                    return False
                db.execute("UPDATE sessions SET workspace=?, project_id=?, updated=? WHERE id=?",
                           (str(directory), project["id"] if project else "", time.time(), sid))
            return True
        except Exception:
            return False

    @staticmethod
    def _list_projects(ws):
        """Projects incl. folders discovered under temp/projects (snapshot runs _discover)."""
        try:
            return list(ws.snapshot()["projects"])
        except Exception:
            return ws.projects()

    def _cmd_project(self, channel, chat, arg):
        ws = self._workspaces()
        try:
            projects = self._list_projects(ws) if ws is not None else None
        except Exception:
            projects = None
        if projects is None:
            return "未加载工作区服务（workspace-store），无法切换项目。"
        sid = self.bindings.get(channel, chat)
        session = self._session(sid)
        current = (session or {}).get("project_id") or ""
        if not arg:
            if not projects:
                return "还没有项目。请先在网页端创建项目。"
            lines = ["项目（* 为本聊天当前项目）："]
            for i, p in enumerate(projects, 1):
                lines.append(f"{'*' if p['id'] == current else ' '}{i}. {p['name']}")
            lines.append(f"{'*' if not current else ' '}none. 无项目（默认目录）")
            lines.append("发送 /project <编号|名称> 切换；/project none 回到默认。")
            return "\n".join(lines)
        target = None
        if arg.lower() not in ("none", "default", "无"):
            if arg.isdigit() and 1 <= int(arg) <= len(projects):
                target = projects[int(arg) - 1]
            else:
                key = arg.casefold()
                hits = [p for p in projects if p["name"].casefold() == key] or \
                       [p for p in projects if key in p["name"].casefold()]
                if len(hits) > 1:
                    names = "、".join(p["name"] for p in hits[:5])
                    return f"有多个项目匹配 '{arg}'：{names}。请用编号或完整名称。"
                target = hits[0] if hits else None
            if target is None:
                return f"没有找到项目 '{arg}'。发送 /projects 查看列表。"
        pid = target["id"] if target else ""
        label = f"项目 {target['name']}" if target else "无项目（默认目录）"
        if session and current == pid:
            return f"本聊天已经在{label}。"
        if session and self.runs.active_for(sid):
            return "本聊天当前的任务还在运行，请等它结束或发送 /stop 后再切换项目。"
        if session and self._rescope(sid, target):
            return f"已切换到{label}（当前会话还没有消息，直接沿用）。"
        self._new_session(channel, chat, self._selection(session), project_id=pid)
        return f"已切换到{label}，并新建了会话。之前的会话可用 /sessions 和 /use 找回。"

    # -- session switching ------------------------------------------------
    def session_choices(self, limit=None):
        """Top-level live sessions, newest first (sub-chats of workers excluded)."""
        rows = [r for r in self.sessions.listing() if not r.get("parent_id")]
        rows.sort(key=lambda r: r.get("updated") or 0, reverse=True)
        return rows[:limit] if limit else rows

    def bind_chat(self, channel, chat, sid):
        """Point a chat at an existing session. Returns an error text, or None on success."""
        chat = str(chat)
        target = self._session(sid)
        if not target:
            return f"会话 {sid} 不存在或已删除。"
        current = self.bindings.get(channel, chat)
        if current == sid:
            return None
        if current and self.runs.active_for(current):
            return "本聊天当前的任务还在运行，请等它结束或发送 /stop 后再切换。"
        if self.runs.active_for(sid):
            return "目标会话正在运行任务，请等它结束后再切换。"
        self.bindings.set(channel, chat, sid)
        return None

    def _cmd_sessions(self, channel, chat, arg=""):
        rows = self.session_choices()
        if not rows:
            return "还没有任何会话。发送消息会自动新建一个。"
        pages = (len(rows) + SESSIONS_PAGE - 1) // SESSIONS_PAGE
        if not arg:
            page = 1
        elif arg.isascii() and arg.isdigit() and 1 <= int(arg) <= pages:
            page = int(arg)
        else:
            return f"页码应为 1-{pages}。"
        start = (page - 1) * SESSIONS_PAGE
        current = self.bindings.get(channel, chat)
        lines = [f"最近的会话（第 {page}/{pages} 页，共 {len(rows)} 个）："]
        for i, r in enumerate(rows[start:start + SESSIONS_PAGE], start + 1):
            mark = "→ " if r["id"] == current else "   "
            when = time.strftime("%m-%d %H:%M", time.localtime(r.get("updated") or 0))
            title = " ".join(str(r.get("title") or "").split())[:40] or "（无标题）"
            busy = " · 运行中" if r.get("running") else ""
            lines.append(f"{mark}{i}. {title}（{when}{busy}）")
        tail = "用 /use <编号> 切换到对应会话。"
        if page < pages:
            tail += f"发送 /sessions {page + 1} 看下一页。"
        lines.append(tail)
        return "\n".join(lines)

    def _cmd_use(self, channel, chat, arg):
        if not arg:
            return "用法：/use <编号|会话ID>。发送 /sessions 查看列表。"
        rows = self.session_choices()
        if arg.isascii() and arg.isdigit():
            n = int(arg)
            if not 1 <= n <= len(rows):
                return f"没有编号为 {arg} 的会话。发送 /sessions 查看列表。"
            hit = rows[n - 1]
        else:
            hit = next((r for r in rows if r["id"] == arg), None)
            if hit is None:
                found = [r for r in rows if r["id"].startswith(arg)]
                if len(found) > 1:
                    return f"'{arg}' 匹配到多个会话，请写完整的会话ID。"
                hit = found[0] if found else None
            if hit is None:
                return f"找不到会话 '{arg}'。发送 /sessions 查看列表。"
        error = self.bind_chat(channel, chat, hit["id"])
        if error:
            return error
        title = " ".join(str(hit.get("title") or "").split())[:40] or hit["id"]
        return f"已切换到会话：{title}\n{self._describe(self._session(hit['id']))}"

    # -- per-chat model / effort ------------------------------------------
    def _catalog(self):
        """(items, host current id) from model-store; ([], None) without it."""
        models = self._models()
        data = (models.catalog() if models is not None else None) or {}
        return list(data.get("items") or []), data.get("current")

    def _stale_model(self, sid):
        """The session's model if the catalog no longer lists it, else None."""
        state = (self._session(sid) or {}).get("state") or {}
        model = state.get("model")
        if not model:
            return None
        try:
            items, _ = self._catalog()
        except Exception:  # no usable catalog: leave the decision to the run
            return None
        return model if items and not self._listed(items, state) else None

    def _labels(self, session):
        """(model, effort) of a session as shown to the chat user."""
        state = (session or {}).get("state") or {}
        items, current = self._catalog()
        model = state.get("model")
        if model and items and not self._listed(items, state):
            model += "（已不在配置中，请用 /model 另选）"
        elif not model:
            host = next((m.get("name") for m in items if m.get("id") == current), None)
            model = f"{host}（宿主默认）" if host else "宿主默认"
        effort = (state["effort"] or "default") if "effort" in state else "跟随宿主设置"
        return model, effort

    def _describe(self, session):
        return "模型：{}\n推理强度：{}".format(*self._labels(session))

    def _busy(self, sid):
        """Refusal while a run is active; settings only change between runs."""
        if self.runs.active_for(sid):
            return "上一个任务还在运行，请等它结束后再修改设置。发送 /stop 可以取消。"
        return None

    def _cmd_effort(self, channel, chat, arg):
        options = ", ".join([*EFFORTS, "default"])
        if not arg:
            session = self._session(self.bindings.get(channel, chat))
            return f"推理强度：{self._labels(session)[1]}\n可选：{options}"
        value = arg.lower()
        if value in ("default", "reset", "clear"):  # drop this chat's override
            value = "default"
        elif value not in EFFORTS:
            return f"未知的推理强度 '{arg}'。可选：{options}"
        sid = self.session_for(channel, chat)
        busy = self._busy(sid)
        if busy:
            return busy
        self.sessions.remember_for(sid, effort=None if value == "default" else value)
        return f"本聊天的推理强度：{value}。"

    def _cmd_model(self, channel, chat, arg):
        items, current = self._catalog()
        if not items:
            return "无法切换模型：模型目录未加载。"
        if not arg:
            session = self._session(self.bindings.get(channel, chat))
            chosen = self._chosen(items, (session or {}).get("state") or {}, current)
            rows = [("-> " if m is chosen else "   ") + f"[{m.get('id')}] {m.get('name')}"
                    + (f" ({m['provider']})" if m.get("provider") else "") for m in items]
            return "\n".join([f"模型：{self._labels(session)[0]}", *rows,
                              "用 /model <编号|名称> 切换。"])
        item, error = self._pick(items, arg)
        if error:
            return error
        sid = self.session_for(channel, chat)
        busy = self._busy(sid)
        if busy:
            return busy
        self.sessions.remember_for(sid, model=item["name"], model_key=item.get("key"))
        return f"本聊天的模型：[{item['id']}] {item['name']}。"

    @staticmethod
    def _pick(items, arg):
        """(item, None) for a catalog id or a unique name/model match, else (None, error)."""
        key = arg.casefold()

        def text(m, k):
            return str(m.get(k) or "").casefold()
        if arg.isascii() and arg.isdigit():  # a bare number is always a catalog id
            hit = [m for m in items if m.get("id") == int(arg)]
            if not hit:
                return None, f"没有编号为 {arg} 的模型。发送 /model 查看列表。"
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
            return None, f"未知模型 '{arg}'。发送 /model 查看列表。"
        names = ", ".join(f"[{m.get('id')}] {m.get('name')}" for m in hit[:10])
        return None, f"'{arg}' 匹配到多个模型：{names}。请用编号选择。"

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
            text = "（已取消）" if status == "aborted" else "（无回复）"
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
                adapter.send(chat, f"[文件未发送：{name}：{e}]")
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
