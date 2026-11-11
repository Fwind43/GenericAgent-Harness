"""Feishu/Lark channel provider.

This plugin only provides the ``feishu`` provider; channels are created,
started and stopped by the channel manager (channels plugin). Each running
channel receives messages through its own ``ws_worker.py`` child process and
replies through the REST API (plain urllib). ``lark-oapi`` is only needed by
the receiver, which runs in the plugin's own environment when one is installed.
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from pathlib import Path

from ga_harness.channel_manager import Provider
from ga_harness.channels import Adapter, split_text

WORKER = Path(__file__).with_name("ws_worker.py")
API = "https://open.feishu.cn/open-apis"
PACKAGES = ["lark-oapi"]


class FeishuApi:
    """Minimal Feishu Open API client (tenant token, messages, media)."""

    def __init__(self, app_id, app_secret, base=API):
        self.app_id, self.app_secret, self.base = app_id, app_secret, base
        self._token, self._expires = "", 0.0
        self._lock = threading.Lock()

    def token(self):
        with self._lock:
            if self._token and time.time() < self._expires:
                return self._token
            data = self._call("POST", "/auth/v3/tenant_access_token/internal",
                              {"app_id": self.app_id, "app_secret": self.app_secret}, auth=False)
            self._token = data.get("tenant_access_token") or ""
            self._expires = time.time() + max(60, int(data.get("expire") or 0) - 300)
            return self._token

    def _open(self, method, path, body=None, headers=None, auth=True):
        h = dict(headers or {})
        if auth:
            h["Authorization"] = "Bearer " + self.token()
        req = urllib.request.Request(self.base + path, data=body, headers=h, method=method)
        try:
            return urllib.request.urlopen(req, timeout=60)
        except urllib.error.HTTPError as e:
            raw = e.read(1 << 20)
            try:
                data = json.loads(raw or b"{}")
            except ValueError:
                data = {}
            raise RuntimeError(f"{data.get('code', e.code)} {data.get('msg') or e.reason}") from None

    def _call(self, method, path, payload=None, auth=True, body=None, ctype=None):
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            ctype = "application/json; charset=utf-8"
        with self._open(method, path, body, {"Content-Type": ctype} if ctype else None,
                        auth=auth) as resp:
            data = json.loads(resp.read() or b"{}")
        if data.get("code", 0) != 0:
            raise RuntimeError(f"{data.get('code')} {data.get('msg')}")
        return data

    def upload(self, path, fields, file_field, filename, content):
        boundary = "gah" + os.urandom(12).hex()
        parts = []
        for k, v in fields.items():
            parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"'
                          f"\r\n\r\n{v}\r\n").encode("utf-8"))
        quoted = filename.replace('"', "%22").replace("\r", "").replace("\n", "")
        parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; '
                      f'filename="{quoted}"\r\nContent-Type: application/octet-stream'
                      "\r\n\r\n").encode("utf-8") + content + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        return self._call("POST", path, body=b"".join(parts),
                          ctype="multipart/form-data; boundary=" + boundary).get("data") or {}

    def send(self, chat_id, msg_type, content):
        data = self._call("POST", "/im/v1/messages?receive_id_type=chat_id", {
            "receive_id": chat_id, "msg_type": msg_type,
            "content": json.dumps(content, ensure_ascii=False)})
        return (data.get("data") or {}).get("message_id") or ""

    def patch(self, message_id, content):
        """Replace the content of a sent interactive (card) message."""
        self._call("PATCH", f"/im/v1/messages/{urllib.parse.quote(message_id, safe='')}",
                   {"content": json.dumps(content, ensure_ascii=False)})

    def resource(self, message_id, key, kind):
        path = (f"/im/v1/messages/{urllib.parse.quote(message_id, safe='')}/resources/"
                f"{urllib.parse.quote(key, safe='')}?type={urllib.parse.quote(kind)}")
        with self._open("GET", path) as resp:
            data = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            disp = resp.headers.get("Content-Disposition", "")
        if ctype.startswith("application/json"):
            try:
                err = json.loads(data)
            except ValueError:
                err = None
            if isinstance(err, dict) and err.get("code"):
                raise RuntimeError(f"{err.get('code')} {err.get('msg')}")
        m = re.search(r"filename\*=(?:UTF-8'')?([^;]+)", disp) or re.search(r'filename="?([^";]+)', disp)
        return data, (urllib.parse.unquote(m.group(1).strip()) if m else None)


def _allowed(config):
    raw = (config or {}).get("allowed_users") or ""
    return {x.strip() for x in raw.split(",") if x.strip()}


def message_text(msg_type, content):
    """Extract plain text from a Feishu message; '' if unsupported."""
    try:
        data = json.loads(content or "{}")
    except Exception:
        return ""
    if msg_type == "text":
        return data.get("text", "")
    if msg_type == "post":
        body = data.get("content") or next(
            (v.get("content") for v in data.values() if isinstance(v, dict)), [])
        lines = [" ".join(seg.get("text", "") for seg in row if isinstance(seg, dict))
                 for row in body or []]
        return "\n".join(x for x in lines if x.strip())
    return ""


def message_media(msg_type, content):
    """Resources attached to a Feishu message: [(file_key, kind, file_name)]."""
    try:
        data = json.loads(content or "{}")
    except Exception:
        return []
    if not isinstance(data, dict):
        return []
    if msg_type == "image" and data.get("image_key"):
        return [(data["image_key"], "image", "image.png")]
    if msg_type in ("file", "audio", "media") and data.get("file_key"):
        default = {"audio": "audio.opus", "media": "video.mp4"}.get(msg_type, "file")
        return [(data["file_key"], "file", data.get("file_name") or default)]
    if msg_type == "post":
        body = data.get("content")
        if body is None:
            body = next((v.get("content") for v in data.values() if isinstance(v, dict)), [])
        segs = [s for row in body or [] if isinstance(row, list) for s in row
                if isinstance(s, dict) and s.get("tag") == "img" and s.get("image_key")]
        return [(s["image_key"], "image", f"image_{i + 1}.png") for i, s in enumerate(segs)]
    return []


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tif", ".tiff", ".heic"}
FILE_TYPES = {".opus": "opus", ".mp4": "mp4", ".pdf": "pdf", ".doc": "doc", ".docx": "doc",
              ".xls": "xls", ".xlsx": "xls", ".csv": "xls", ".ppt": "ppt", ".pptx": "ppt"}


CARD_FINAL_MAX = 9000     # final answer chars kept inside the card; the rest follows as text
CARD_PANEL_MAX = 3000     # detail chars per turn panel
CARD_MAX_BYTES = 28000    # Feishu caps card JSON at ~30 KB; oldest panels are folded away


def _clip(text, limit):
    text = (text or "").strip()
    return text if len(text) <= limit else text[:limit].rstrip() + " \u2026"


def _one_line(text, limit=60):
    return _clip(" ".join(str(text or "").split()), limit)


TOOL_CODE_KEYS = ("script", "code", "command", "cmd", "js")
TOOL_MAIN_KEYS = ("path", "file", "url", "query", "pattern", "question", "text", "prompt")
TOOL_CODE_LINES = 12
TOOL_CODE_CHARS = 700


def _code_block(code, lang=""):
    lines = str(code).strip("\n").splitlines()
    more = len(lines) - TOOL_CODE_LINES
    body = _clip("\n".join(lines[:TOOL_CODE_LINES]), TOOL_CODE_CHARS).replace("```", "\u02cb\u02cb\u02cb")
    if more > 0:
        body += f"\n# \u2026 +{more} lines"
    return f"```{lang}\n{body}\n```"


def _result_preview(data):
    """One readable line from a tool result (stdout/msg/error if JSON)."""
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            pass
    if isinstance(data, dict):
        for key in ("error", "stderr", "stdout", "result", "msg", "message", "content"):
            if data.get(key):
                data = data[key]
                break
    if not isinstance(data, str):
        try:
            data = json.dumps(data, ensure_ascii=False)
        except (TypeError, ValueError):
            data = str(data)
    return _one_line(data, 160)


def _fmt_tool(tool):
    mark = "\u23f3" if tool["ok"] is None else ("\u2705" if tool["ok"] else "\u274c")
    secs = tool["seconds"]
    took = f" <font color='grey'>{secs:.1f}s</font>" if isinstance(secs, (int, float)) else ""
    out = [f"{mark} **{tool['name']}**{took}"]
    args = tool["args"]
    if isinstance(args, dict):
        rest = dict(args)
        for k in TOOL_CODE_KEYS:
            if isinstance(rest.get(k), str) and rest[k].strip():
                code = rest.pop(k)
                kind = str(rest.get("type") or "").lower()
                lang = ("javascript" if k == "js" or "js" in tool["name"] else
                        "powershell" if kind == "powershell" else
                        "bash" if k in ("command", "cmd") else "python")
                rest.pop("type", None)
                out.append(_code_block(code, lang))
                break
        for k in TOOL_MAIN_KEYS:
            if k in rest and rest[k] not in (None, ""):
                out.insert(1, f"`{_one_line(rest.pop(k), 120).replace('`', chr(39))}`")
                break
        extra = [f"{k}={_one_line(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False), 40)}"
                 for k, v in rest.items() if v not in (None, "", [], {})]
        if extra:
            out.append("<font color='grey'>" + _one_line(" \u00b7 ".join(extra), 160).replace("<", "&lt;") + "</font>")
    elif args not in (None, ""):
        out.append(f"`{_one_line(args, 160).replace('`', chr(39))}`")
    if tool.get("result"):
        res = tool["result"].replace("<", "&lt;")
        out.append(f"<font color='{'red' if tool['ok'] is False else 'grey'}'>\u21b3 {res}</font>")
    return "\n".join(out)


class TaskCard:
    """One run rendered as a Feishu JSON 2.0 card, mirroring GA's fsapp:
    a status line, one collapsed panel per turn, then the final answer."""

    def __init__(self):
        self.mid, self.patched = "", 0.0
        self.turns = OrderedDict()  # turn number -> {"summary", "reply", "tools"}
        self.current = 0
        self.state, self.final, self.error = "running", "", ""
        self.answer = ""  # full final answer, used to de-duplicate the last turn

    def _turn(self, data):
        n = data.get("turn")
        n = n if isinstance(n, int) else (self.current or 1)
        self.current = max(self.current, n)
        return self.turns.setdefault(n, {"summary": "", "reply": "", "tools": []})

    def apply(self, name, data):
        """Fold one run event in; True if the card changed visibly."""
        data = data if isinstance(data, dict) else {}
        if name == "turn.start":
            self._turn(data)
        elif name == "assistant.text":
            t = self._turn(data)
            t["summary"] = _one_line(data.get("summary") or "")
            t["reply"] = data.get("reply") or data.get("text") or ""
        elif name == "tool.call":
            args = data.get("args")
            if isinstance(args, dict):
                args = {k: v for k, v in args.items() if not str(k).startswith("_")}
            self._turn(data)["tools"].append(
                {"id": data.get("id"), "name": str(data.get("name") or "tool"),
                 "args": args, "ok": None, "seconds": None, "result": ""})
        elif name == "tool.result":
            for tool in reversed(self._turn(data)["tools"]):
                if tool["id"] == data.get("id") or (data.get("id") is None and tool["ok"] is None):
                    tool["ok"], tool["seconds"] = bool(data.get("ok", True)), data.get("seconds")
                    tool["result"] = _result_preview(data.get("data"))
                    break
        elif name != "turn.end":
            return False
        return True

    def complete(self, text, status, error=None):
        """Mark the run finished; returns answer text that did not fit the card."""
        self.state = status if status in ("aborted", "error", "interrupted") else "done"
        self.error = _one_line(error or "", 300)
        text = (text or "").strip()
        self.answer = text
        if len(text) <= CARD_FINAL_MAX:
            self.final = text
            return ""
        cut = text.rfind("\n", 0, CARD_FINAL_MAX)
        cut = cut if cut > CARD_FINAL_MAX // 2 else CARD_FINAL_MAX
        self.final = text[:cut].rstrip() + "\n\n*\u2026\uff08\u4f59\u4e0b\u5185\u5bb9\u89c1\u4e0b\u4e00\u6761\u6d88\u606f\uff09*"
        return text[cut:].strip()

    def _status(self):
        n = len(self.turns)
        if self.state == "running":
            if not n:
                return "**\U0001f914 \u601d\u8003\u4e2d\u2026**"
            return f"**\u23f3 \u5de5\u4f5c\u4e2d \u00b7 Turn {self.current}**"
        suffix = f" \u00b7 {n} turns" if n else ""
        if self.state == "done":
            return f"**\u2705 \u5df2\u5b8c\u6210{suffix}**"
        if self.state == "aborted":
            return f"**\u23f9 \u5df2\u53d6\u6d88{suffix}**"
        if self.state == "interrupted":
            return f"**\u26a0\ufe0f \u5df2\u4e2d\u65ad{suffix}**"
        return f"**\u274c \u51fa\u9519\uff1a{self.error or 'unknown error'}**"

    @staticmethod
    def _panel(n, t):
        # Sections like fsapp's step detail (Output / Tool Calls), but each
        # tool gets a status line, its main argument (code in a fenced block)
        # and a one-line result preview. Whole blocks are dropped rather than
        # cut mid-way so a code fence never stays open.
        blocks = []
        # The summary is already the panel title; drop its raw tag here.
        reply = re.sub(r"<summary>.*?</summary>", "", t["reply"] or "", flags=re.S).strip()
        if reply:
            blocks.append("**\U0001f4dd \u8f93\u51fa**\n" + _clip(reply, CARD_PANEL_MAX // 2))
        if t["tools"]:
            blocks.append(f"**\U0001f6e0 \u5de5\u5177\u8c03\u7528 \u00b7 {len(t['tools'])}**")
            blocks += [_fmt_tool(tool) for tool in t["tools"]]
        kept, used = [], 0
        for b in blocks:
            if kept and used + len(b) > CARD_PANEL_MAX:
                kept.append(f"*\u2026 \u53e6\u6709 {len(blocks) - len(kept)} \u9879\u672a\u663e\u793a*")
                break
            kept.append(b)
            used += len(b)
        detail = "\n\n".join(kept)
        title = f"Turn {n}" + (f" \u00b7 {t['summary']}" if t["summary"] else "")
        # Explicit chevron + border: without them Feishu draws the header as
        # plain text and the panel does not look expandable.
        return {"tag": "collapsible_panel", "expanded": False,
                "background_color": "grey",
                "border": {"color": "grey", "corner_radius": "5px"},
                "vertical_spacing": "8px", "padding": "8px 8px 8px 8px",
                "header": {"title": {"tag": "plain_text", "content": _one_line(title, 80)},
                           "vertical_align": "center",
                           "icon": {"tag": "standard_icon", "token": "down-small-ccm_outlined",
                                    "size": "16px 16px"},
                           "icon_position": "right", "icon_expanded_angle": -180},
                "elements": [{"tag": "markdown", "content": detail or "\u2026"}]}

    def _visible_turns(self):
        """Turns to draw; the last turn's reply is dropped when it is the
        final answer shown below the divider (and the panel too if empty)."""
        items = list(self.turns.items())
        if not (self.final and items):
            return items
        n, last = items[-1]
        norm = lambda x: " ".join(str(x or "").split())
        reply, answer = norm(last["reply"]), norm(self.answer)
        if reply and answer and (reply in answer or answer in reply):
            if not last["tools"]:
                return items[:-1]
            items[-1] = (n, dict(last, reply=""))
        return items

    def render(self):
        visible = self._visible_turns()
        panels = [self._panel(n, t) for n, t in visible]
        while True:
            elements = [{"tag": "markdown", "content": self._status()}]
            hidden = len(visible) - len(panels)
            if hidden:
                elements.append({"tag": "markdown",
                                 "content": f"*\u2026 \u7701\u7565\u524d {hidden} \u8f6e*"})
            elements += panels
            if self.final:
                elements += [{"tag": "hr"}, {"tag": "markdown", "content": self.final}]
            card = {"schema": "2.0", "config": {"streaming_mode": False, "width_mode": "fill"},
                    "body": {"elements": elements}}
            size = len(json.dumps(card, ensure_ascii=False).encode("utf-8"))
            if size <= CARD_MAX_BYTES or not panels:
                return card
            panels.pop(0)


class FeishuAdapter(Adapter):
    max_len = 4000

    def __init__(self, name, app_id, app_secret, allowed=(), log=None, on_dead=None):
        self.name = name
        self.app_id, self.app_secret = app_id, app_secret
        self.allowed = set(allowed)
        self.log = log or (lambda level, text: None)
        self.on_dead = on_dead
        self.seen, self.lock = OrderedDict(), threading.Lock()
        self.cards = OrderedDict()  # (chat_id, run_id) -> TaskCard
        self.client = self.proc = self.reader = None
        self.stopping = False

    def claim(self, message_id):
        """True the first time a message id is seen (Feishu redelivers)."""
        with self.lock:
            if not message_id or message_id in self.seen:
                return not message_id
            self.seen[message_id] = True
            while len(self.seen) > 1000:
                self.seen.popitem(last=False)
            return True

    def handle(self, ev):
        """Process one message event (dict) emitted by ws_worker."""
        if not self.claim(ev.get("message_id", "")):
            return
        user = ev.get("user") or ""
        if self.allowed and user not in self.allowed:
            self.log("info", f"ignored message from {user} (not allowed)")
            return
        text = re.sub(r"@_user_\d+\s*", "",
                      message_text(ev.get("msg_type"), ev.get("content"))).strip()
        files = []
        for key, kind, name in message_media(ev.get("msg_type"), ev.get("content")):
            try:
                files.append(self.download(ev.get("message_id", ""), key, kind, name))
            except Exception as e:
                self.log("error", f"download {kind} failed: {e}")
        if text or files:
            self.log("info", f"message from {user} in {ev.get('chat_id')}"
                             + (f" with {len(files)} file(s)" if files else ""))
            self.hub.receive(self.name, ev.get("chat_id"), text, user=user, files=files)

    def _client(self):
        client = self.client
        if client is None:
            raise RuntimeError("feishu adapter is stopped")
        return client

    def download(self, message_id, key, kind, name):
        data, fname = self._client().resource(message_id, key, kind)
        return {"name": fname or name, "data": data}

    def start(self, hub):
        super().start(hub)
        from ga_harness.packages import python_for
        if self.proc is not None or (self.reader is not None and self.reader.is_alive()):
            self.stop()
        self.stopping = False
        self.client = FeishuApi(self.app_id, self.app_secret)
        # GAH_PARENT_PID: the receiver exits by itself if this process dies without stop().
        env = dict(os.environ, GAH_FEISHU_APP_ID=self.app_id,
                   GAH_FEISHU_APP_SECRET=self.app_secret, PYTHONIOENCODING="utf-8",
                   GAH_PARENT_PID=str(os.getpid()))
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(
            [python_for("feishu", PACKAGES), "-u", str(WORKER)], env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=flags)
        self.proc = proc
        self.reader = threading.Thread(target=self._read, args=(proc,),
                                       name=f"gah-{self.name}", daemon=True)
        self.reader.start()

    def _read(self, proc=None):
        if proc is None:
            proc = self.proc
        if proc is None or proc.stdout is None:
            return
        try:
            for raw in proc.stdout:
                if self.stopping:
                    return
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    self.log("info", line[:500])  # lark's own log output
                    continue
                kind = ev.get("type")
                if kind == "message":
                    try:
                        self.handle(ev)
                    except Exception as e:
                        self.log("error", f"handle failed: {e}")
                elif kind == "fatal":
                    self.log("error", ev.get("text", "worker failed"))
                else:
                    self.log(ev.get("level", "info"), ev.get("text", ""))
            if self.stopping:
                return
            code = proc.wait()
        except Exception as e:
            if not self.stopping and self.proc in (None, proc):
                self.log("error", f"receiver reader failed: {e}")
                if self.on_dead:
                    self.on_dead(f"receiver reader failed: {e}")
            return
        finally:
            try:
                proc.stdout.close()
            except Exception:
                pass
        if not self.stopping and self.proc in (None, proc):
            self.log("error", f"receiver exited (code {code})")
            if self.on_dead:
                self.on_dead(f"receiver exited (code {code})")

    def send(self, chat_id, text):
        self._create(chat_id, "text", {"text": text})

    def send_file(self, chat_id, path):
        client = self._client()
        ext = os.path.splitext(path)[1].lower()
        if ext in IMAGE_EXTS and os.path.getsize(path) <= 10 << 20:
            with open(path, "rb") as f:
                content = f.read()
            try:
                data = client.upload("/im/v1/images", {"image_type": "message"}, "image",
                                     os.path.basename(path), content)
            except RuntimeError as e:
                raise RuntimeError(f"feishu image upload failed: {e}") from None
            return self._create(chat_id, "image", {"image_key": data.get("image_key")})
        with open(path, "rb") as f:
            content = f.read()
        name = os.path.basename(path)
        try:
            data = client.upload("/im/v1/files", {
                "file_type": FILE_TYPES.get(ext, "stream"), "file_name": name}, "file", name, content)
        except RuntimeError as e:
            raise RuntimeError(f"feishu file upload failed: {e}") from None
        self._create(chat_id, "file", {"file_key": data.get("file_key")})

    def _create(self, chat_id, msg_type, content):
        try:
            return self._client().send(chat_id, msg_type, content)
        except RuntimeError as e:
            raise RuntimeError(f"feishu send failed: {e}") from None

    # -- task card (one interactive card per run, patched as turns progress) --
    def progress(self, chat_id, run_id, name, data):
        key = (chat_id, run_id)
        with self.lock:
            card = self.cards.get(key)
            if card is None:
                card = self.cards[key] = TaskCard()
                while len(self.cards) > 50:
                    self.cards.pop(next(iter(self.cards)))
        if not card.apply(name, data):
            return
        now = time.monotonic()
        if card.mid and name not in ("turn.start", "turn.end") and now - card.patched < 1.0:
            return  # throttle; the next boundary event or finish() catches up
        self._show(chat_id, card)
        card.patched = now

    def finish(self, chat_id, run_id, text, status, error=None):
        with self.lock:
            card = self.cards.pop((chat_id, run_id), None) or TaskCard()
        overflow = card.complete(text, status, error)
        self._show(chat_id, card)
        for part in split_text(overflow, self.max_len) if overflow else ():
            self.send(chat_id, part)

    def _show(self, chat_id, card):
        body = card.render()
        if card.mid:
            try:
                self._client().patch(card.mid, body)
            except RuntimeError as e:
                raise RuntimeError(f"feishu card update failed: {e}") from None
        else:
            card.mid = self._create(chat_id, "interactive", body)

    def stop(self):
        self.stopping = True
        proc, self.proc = self.proc, None
        reader, self.reader = self.reader, None
        if proc and proc.poll() is None:
            proc.kill()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        if reader and reader.is_alive() and reader is not threading.current_thread():
            reader.join(timeout=3)
        self.client = None
        self.log("info", "stopped")


FIELDS = [
    {"key": "app_id", "label": "App ID", "label_zh": "App ID", "required": True},
    {"key": "app_secret", "label": "App Secret", "label_zh": "App Secret",
     "required": True, "secret": True},
    {"key": "allowed_users", "label": "Allowed open_ids, comma separated (empty = everyone)",
     "label_zh": "允许的 open_id，逗号分隔（留空为所有人）"},
]


ACCOUNTS = {"feishu": "https://accounts.feishu.cn", "lark": "https://accounts.larksuite.com"}


def _registration(base, action, params=None):
    data = urllib.parse.urlencode(dict(params or {}, action=action)).encode()
    req = urllib.request.Request(base + "/oauth/v1/app/registration", data=data, headers={
        "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read(1 << 20) or b"{}")
    except urllib.error.HTTPError as e:
        # OAuth device flow reports pending/slow_down/denied as HTTP 400 with
        # a JSON error body; surface that body instead of the bare status.
        body = e.read(1 << 20)
        try:
            data = json.loads(body or b"{}")
        except ValueError:
            data = None
        if isinstance(data, dict) and data.get("error"):
            return data
        raise


def pair(update, cancelled):
    """Scan-to-create a Feishu/Lark PersonalAgent bot (app registration)."""
    base = ACCOUNTS["feishu"]
    init = _registration(base, "init")
    if init.get("error"):
        raise RuntimeError(f"{init['error']}: {init.get('error_description', '')}")
    methods = init.get("supported_auth_methods") or []
    if methods and "client_secret" not in methods:
        raise RuntimeError("this environment does not support client_secret auth")
    begin = _registration(base, "begin", {"archetype": "PersonalAgent",
                                          "auth_method": "client_secret",
                                          "request_user_info": "open_id"})
    if begin.get("error"):
        raise RuntimeError(f"{begin['error']}: {begin.get('error_description', '')}")
    code, url = begin.get("device_code"), begin.get("verification_uri_complete")
    if not (code and url):
        raise RuntimeError("incomplete onboarding response")
    update(status="wait", qr=url, text="Scan with the Feishu/Lark app")
    interval = int(begin.get("interval") or 5)
    deadline = time.time() + int(begin.get("expires_in") or begin.get("expire_in") or 600)
    while time.time() < deadline:
        for _ in range(interval * 10):
            if cancelled():
                raise RuntimeError("cancelled")
            time.sleep(0.1)
        res = _registration(base, "poll", {"device_code": code})
        brand = ((res.get("user_info") or {}).get("tenant_brand") or "").strip().lower()
        if brand == "lark" and base != ACCOUNTS["lark"]:
            base = ACCOUNTS["lark"]  # Lark tenants finish on the Lark domain
            continue
        if res.get("client_id") and res.get("client_secret"):
            owner = (res.get("user_info") or {}).get("open_id") or ""
            return {"app_id": res["client_id"], "app_secret": res["client_secret"],
                    "allowed_users": owner}
        err = res.get("error") or ""
        if err == "slow_down":
            interval += 5
        elif err == "access_denied":
            raise RuntimeError("authorization denied by user")
        elif err == "expired_token":
            raise RuntimeError("QR code expired")
        elif err not in ("", "authorization_pending"):
            raise RuntimeError(f"{err}: {res.get('error_description', '')}")
        else:
            update(status="wait", qr=url, text="Waiting for confirmation in the app")
    raise RuntimeError("QR login timed out")


class _Manifest:
    name, isolated, packages = "feishu", True, PACKAGES


def apply(ctx, config):
    manager = ctx.get("channel_manager")

    def factory(cid, cfg, log):
        app_id = (cfg.get("app_id") or "").strip()
        app_secret = (cfg.get("app_secret") or "").strip()
        if not (app_id and app_secret):
            raise RuntimeError("App ID / App Secret are required")
        from ga_harness.packages import missing_for
        if missing_for(ctx.get("manifest") or _Manifest()):
            raise RuntimeError("lark-oapi is not installed; install it from the plugin manager")
        return FeishuAdapter(cid, app_id, app_secret, _allowed(cfg), log=log,
                             on_dead=lambda err: manager.fail(cid, err))

    return manager.register_provider(Provider(
        "feishu", factory, label="Feishu / Lark", label_zh="飞书", fields=FIELDS,
        pair=pair))
