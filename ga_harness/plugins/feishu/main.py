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
from ga_harness.channels import Adapter

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
        self._call("POST", "/im/v1/messages?receive_id_type=chat_id", {
            "receive_id": chat_id, "msg_type": msg_type,
            "content": json.dumps(content, ensure_ascii=False)})

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


class FeishuAdapter(Adapter):
    max_len = 4000

    def __init__(self, name, app_id, app_secret, allowed=(), log=None, on_dead=None):
        self.name = name
        self.app_id, self.app_secret = app_id, app_secret
        self.allowed = set(allowed)
        self.log = log or (lambda level, text: None)
        self.on_dead = on_dead
        self.seen, self.lock = OrderedDict(), threading.Lock()
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

    def download(self, message_id, key, kind, name):
        data, fname = self.client.resource(message_id, key, kind)
        return {"name": fname or name, "data": data}

    def start(self, hub):
        super().start(hub)
        from ga_harness.packages import python_for
        self.client = FeishuApi(self.app_id, self.app_secret)
        env = dict(os.environ, GAH_FEISHU_APP_ID=self.app_id,
                   GAH_FEISHU_APP_SECRET=self.app_secret, PYTHONIOENCODING="utf-8")
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self.proc = subprocess.Popen(
            [python_for("feishu", PACKAGES), "-u", str(WORKER)], env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=flags)
        self.reader = threading.Thread(target=self._read, name=f"gah-{self.name}",
                                       daemon=True)
        self.reader.start()

    def _read(self):
        for raw in self.proc.stdout:
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
        code = self.proc.wait()
        if not self.stopping:
            self.log("error", f"receiver exited (code {code})")
            if self.on_dead:
                self.on_dead(f"receiver exited (code {code})")

    def send(self, chat_id, text):
        self._create(chat_id, "text", {"text": text})

    def send_file(self, chat_id, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in IMAGE_EXTS and os.path.getsize(path) <= 10 << 20:
            with open(path, "rb") as f:
                content = f.read()
            try:
                data = self.client.upload("/im/v1/images", {"image_type": "message"}, "image",
                                          os.path.basename(path), content)
            except RuntimeError as e:
                raise RuntimeError(f"feishu image upload failed: {e}") from None
            return self._create(chat_id, "image", {"image_key": data.get("image_key")})
        with open(path, "rb") as f:
            content = f.read()
        name = os.path.basename(path)
        try:
            data = self.client.upload("/im/v1/files", {
                "file_type": FILE_TYPES.get(ext, "stream"), "file_name": name}, "file", name, content)
        except RuntimeError as e:
            raise RuntimeError(f"feishu file upload failed: {e}") from None
        self._create(chat_id, "file", {"file_key": data.get("file_key")})

    def _create(self, chat_id, msg_type, content):
        try:
            self.client.send(chat_id, msg_type, content)
        except RuntimeError as e:
            raise RuntimeError(f"feishu send failed: {e}") from None

    def stop(self):
        self.stopping = True
        proc, self.proc = self.proc, None
        if proc and proc.poll() is None:
            proc.kill()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
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
