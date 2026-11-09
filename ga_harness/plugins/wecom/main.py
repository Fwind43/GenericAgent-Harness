"""WeCom (Enterprise WeChat AI Bot) channel provider for ga-harness.

Connects to the official WeCom AI Bot WebSocket gateway
(``wss://openws.work.weixin.qq.com``) with ``bot_id`` + ``secret`` (no public
webhook URL or callback server required). Supports:

- Inbound text, voice (speech-to-text), image, file, video, mixed and quoted
  messages, with AES-256-CBC media decryption.
- Real-time turn progress and final answers via ``aibot_respond_msg``
  (``msgtype="stream"``), falling back to ``aibot_send_msg`` (``markdown``)
  for proactive notifications or expired reply contexts.
- Outbound images, videos, voice and files via chunked WebSocket media upload
  (``aibot_upload_media_init`` / ``chunk`` / ``finish`` + ``aibot_send_msg``).
"""
from __future__ import annotations

import base64
from collections import deque
import hashlib
import json
import os
import re
import socket
import ssl
import struct
import threading
import time
import urllib.parse
import urllib.request
import uuid

from ga_harness.channel_manager import Provider
from ga_harness.channels import Adapter, split_text


WS_URL = "wss://openws.work.weixin.qq.com"
VERSION = "ga-harness-wecom/1.0"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

CMD_SUBSCRIBE = "aibot_subscribe"
CMD_PING = "ping"
CMD_RESPONSE = "response"
CMD_RESPOND_WELCOME = "aibot_respond_welcome_msg"
CMD_RESPOND_MSG = "aibot_respond_msg"
CMD_SEND_MSG = "aibot_send_msg"
CMD_UPLOAD_INIT = "aibot_upload_media_init"
CMD_UPLOAD_CHUNK = "aibot_upload_media_chunk"
CMD_UPLOAD_FINISH = "aibot_upload_media_finish"
CMD_MSG_CALLBACK = "aibot_msg_callback"
CMD_EVENT_CALLBACK = "aibot_event_callback"

HEARTBEAT_INTERVAL = 25.0
MAX_MISSED_PONG = 2
RECONNECT_BASE = 2.0
RECONNECT_MAX = 30.0
UPDATE_GAP = 0.6
CHUNK_SIZE = 512 * 1024
MAX_CHUNKS = 100
MAX_FILE_BYTES = 20 * 1024 * 1024

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
VOICE_EXTS = {".amr"}

SUMMARY_RE = re.compile(r"<summary>(.*?)</summary>", re.S)
MENTION_RE = re.compile(r"^@\S+\s*")

FIELDS = [
    {"key": "bot_id", "label": "Bot ID", "label_zh": "Bot ID",
     "required": True, "placeholder": "aib..."},
    {"key": "secret", "label": "Secret", "label_zh": "Secret",
     "required": True, "secret": True},
    {"key": "allowed_users",
     "label": "Allowed user IDs, comma separated (blank = everyone)",
     "label_zh": "允许的用户 ID，逗号分隔（留空允许所有人）",
     "placeholder": "zhangsan,lisi"},
    {"key": "ws_url",
     "label": "WebSocket URL (optional)",
     "label_zh": "WebSocket 地址（可选）",
     "placeholder": WS_URL},
]


def _req_id(prefix: str = "req") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


# -- AES-256-CBC media decryption & HTTP download -----------------------------

def _decode_aes_key(aes_key: str | bytes) -> bytes:
    if isinstance(aes_key, (bytes, bytearray)):
        raw = bytes(aes_key)
        if len(raw) == 32:
            return raw
        aes_key = raw.decode("ascii", "ignore")
    s = (aes_key or "").strip()
    if not s:
        raise ValueError("empty aes_key")
    rem = len(s) % 4
    if rem:
        s += "=" * (4 - rem)
    key = base64.b64decode(s)
    if len(key) != 32:
        raise ValueError(f"invalid AES-256 key length: {len(key)} (expected 32)")
    return key


def _aes_cbc_decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    for mod in ("Cryptodome.Cipher", "Crypto.Cipher"):
        try:
            AES = __import__(mod, fromlist=["AES"]).AES
            return AES.new(key, AES.MODE_CBC, iv=iv).decrypt(data)
        except ImportError:
            pass
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    except ImportError as e:
        raise RuntimeError(
            "WeCom media decryption requires pycryptodome or cryptography"
        ) from e
    dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    return dec.update(data) + dec.finalize()


def decrypt_media(data: bytes, aes_key: str | bytes) -> bytes:
    """Decrypt WeCom AES-256-CBC encrypted media (IV = key[:16], PKCS#7 up to 32)."""
    if not data:
        raise ValueError("empty encrypted media payload")
    key = _decode_aes_key(aes_key)
    raw = _aes_cbc_decrypt(key, key[:16], bytes(data))
    if not raw:
        raise ValueError("decrypted payload is empty")
    pad = raw[-1]
    if not 1 <= pad <= 32 or raw[-pad:] != bytes([pad]) * pad:
        raise ValueError(f"invalid PKCS#7 padding ({pad})")
    return raw[:-pad]


def _filename_from_headers(headers, url: str) -> str | None:
    cd = (headers.get("Content-Disposition") if headers else None) or ""
    m = re.search(r"filename\*=UTF-8''([^;\s]+)", cd, re.I)
    if m:
        return urllib.parse.unquote(m.group(1))
    m = re.search(r'filename="?([^";\s]+)"?', cd, re.I)
    if m:
        return urllib.parse.unquote(m.group(1))
    path = urllib.parse.urlparse(url).path
    base = os.path.basename(path.rstrip("/"))
    return urllib.parse.unquote(base) if base and "." in base else None


def download_media(url: str, aes_key: str | None = None, timeout: float = 30.0) -> tuple[bytes, str | None]:
    """Download media from ``url`` and optionally decrypt with ``aes_key``."""
    req = urllib.request.Request(url, headers={"User-Agent": VERSION})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        name = _filename_from_headers(resp.headers, url)
    if aes_key:
        raw = decrypt_media(raw, aes_key)
    return raw, name


# -- Inbound message parsing --------------------------------------------------

def _strip_mention(text: str, chattype: str) -> str:
    if chattype == "group":
        return MENTION_RE.sub("", text or "", count=1).strip()
    return (text or "").strip()


def _extract_item(item: dict, chattype: str, downloader, log) -> tuple[str, list[dict]]:
    mtype = (item or {}).get("msgtype") or ""
    if mtype == "text":
        raw = (item.get("text") or {}).get("content") or ""
        return _strip_mention(raw, chattype), []
    if mtype == "voice":
        raw = (item.get("voice") or {}).get("content") or ""
        return _strip_mention(raw, chattype), []
    if mtype in ("image", "file", "video"):
        info = item.get(mtype) or {}
        url = info.get("url")
        if not url:
            return "", []
        default_name = (
            info.get("filename")
            or info.get("name")
            or {"image": "image.jpg", "video": "video.mp4", "file": "file.bin"}[mtype]
        )
        try:
            data, hdr_name = downloader(url, info.get("aeskey"))
            name = info.get("filename") or info.get("name") or hdr_name or default_name
            return "", [{"name": name, "data": data}]
        except Exception as e:  # noqa: BLE001
            if log:
                log("error", f"media download failed ({mtype}): {e}")
            return "", []
    if mtype == "mixed":
        texts, files = [], []
        for sub in (item.get("mixed") or {}).get("msg_item") or []:
            t, f = _extract_item(sub, chattype, downloader, log)
            if t:
                texts.append(t)
            files.extend(f)
        return "\n".join(texts).strip(), files
    return "", []


def extract_message(body: dict, downloader=download_media, log=None) -> tuple[str, list[dict]]:
    """Return ``(text, files)`` from a WeCom ``aibot_msg_callback`` body."""
    chattype = body.get("chattype") or "single"
    text, files = _extract_item(body, chattype, downloader, log)
    quote = body.get("quote")
    if isinstance(quote, dict):
        qtext, qfiles = _extract_item(quote, "single", downloader, log)
        if qtext:
            prefix = f"[引用: {qtext[:300]}]"
            text = f"{prefix}\n{text}".strip() if text else prefix
        files = qfiles + files
    return text, files


# -- Minimal RFC 6455 WebSocket client (stdlib socket + ssl) ------------------

class WsClosed(RuntimeError):
    """Raised when the WebSocket connection is closed."""


class WsConn:
    """Thread-safe RFC 6455 WebSocket client using Python stdlib only."""

    def __init__(self, url: str, timeout: float = 15.0):
        self.url = url
        self.timeout = timeout
        self.sock: socket.socket | None = None
        self.send_lock = threading.Lock()
        self.closed = False

    def connect(self):
        parsed = urllib.parse.urlparse(self.url)
        scheme = (parsed.scheme or "wss").lower()
        if scheme not in ("ws", "wss"):
            raise ValueError(f"unsupported WebSocket scheme: {scheme}")
        host = parsed.hostname
        if not host:
            raise ValueError(f"invalid WebSocket URL: {self.url}")
        port = parsed.port or (443 if scheme == "wss" else 80)
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"

        raw_sock = socket.create_connection((host, port), timeout=self.timeout)
        if scheme == "wss":
            ctx = ssl.create_default_context()
            sock = ctx.wrap_socket(raw_sock, server_hostname=host)
        else:
            sock = raw_sock

        key = base64.b64encode(os.urandom(16)).decode("ascii")
        host_hdr = f"{host}:{port}" if parsed.port else host
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host_hdr}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"User-Agent: {VERSION}\r\n\r\n"
        )
        sock.sendall(req.encode("ascii"))

        header_buf = bytearray()
        while b"\r\n\r\n" not in header_buf:
            chunk = sock.recv(1)
            if not chunk:
                sock.close()
                raise WsClosed("WebSocket handshake closed before completion")
            header_buf.extend(chunk)
            if len(header_buf) > 16384:
                sock.close()
                raise WsClosed("WebSocket handshake header too large")

        header_text = header_buf.decode("latin1")
        lines = header_text.split("\r\n")
        status_line = lines[0] if lines else ""
        if " 101 " not in status_line:
            sock.close()
            raise WsClosed(f"WebSocket handshake failed: {status_line}")

        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        expected = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
        ).decode("ascii")
        if headers.get("sec-websocket-accept") != expected:
            sock.close()
            raise WsClosed("invalid Sec-WebSocket-Accept header")

        sock.settimeout(None)
        self.sock = sock
        return self

    def _recv_exact(self, n: int) -> bytes:
        buf = bytearray()
        sock = self.sock
        if sock is None:
            raise WsClosed("socket is not connected")
        while len(buf) < n:
            try:
                chunk = sock.recv(n - len(buf))
            except OSError as e:
                raise WsClosed(str(e)) from e
            if not chunk:
                raise WsClosed("connection closed by peer")
            buf.extend(chunk)
        return bytes(buf)

    def _send_frame(self, opcode: int, payload: bytes = b""):
        with self.send_lock:
            sock = self.sock
            if self.closed or sock is None:
                raise WsClosed("connection is closed")
            mask_key = os.urandom(4)
            header = bytearray([0x80 | (opcode & 0x0F)])
            length = len(payload)
            if length < 126:
                header.append(0x80 | length)
            elif length < 65536:
                header.append(0x80 | 126)
                header.extend(struct.pack("!H", length))
            else:
                header.append(0x80 | 127)
                header.extend(struct.pack("!Q", length))
            header.extend(mask_key)
            masked = bytes(b ^ mask_key[i & 3] for i, b in enumerate(payload))
            try:
                sock.sendall(bytes(header) + masked)
            except OSError as e:
                raise WsClosed(str(e)) from e

    def send_json(self, data: dict):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self._send_frame(0x1, raw)

    def recv_json(self) -> dict:
        fragments = bytearray()
        while True:
            b1, b2 = self._recv_exact(2)
            fin = bool(b1 & 0x80)
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._recv_exact(8))[0]
            mask_key = self._recv_exact(4) if masked else b""
            payload = self._recv_exact(length) if length else b""
            if masked:
                payload = bytes(b ^ mask_key[i & 3] for i, b in enumerate(payload))

            if opcode == 0x8:  # close
                self.close()
                raise WsClosed("server sent close frame")
            if opcode == 0x9:  # ping
                try:
                    self._send_frame(0xA, payload)
                except WsClosed:
                    pass
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode in (0x0, 0x1, 0x2):
                fragments.extend(payload)
                if fin:
                    text = fragments.decode("utf-8", "replace")
                    return json.loads(text) if text.strip() else {}

    def close(self):
        self.closed = True
        sock, self.sock = self.sock, None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass


# -- Turn progress & stream state (analogous to Feishu TaskCard) --------------

def _clean_text(text: str) -> str:
    return SUMMARY_RE.sub("", text or "").lstrip("\r\n")


def _extract_summary(text: str) -> str:
    m = SUMMARY_RE.search(text or "")
    return re.sub(r"\s+", " ", m.group(1)).strip()[:80] if m else ""


def _tool_arg(name: str, args) -> str:
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            return args.strip()[:120]
    if not isinstance(args, dict):
        return ""
    for k in ("path", "file_path", "command", "cmd", "query", "url", "pattern"):
        if args.get(k):
            return str(args[k]).strip().splitlines()[0][:120]
    if args.get("script"):
        lines = [ln.strip() for ln in str(args["script"]).strip().splitlines() if ln.strip()]
        return lines[0][:100] if lines else ""
    return ""


class TaskStream:
    """In-memory state of one run's WeCom ``msgtype="stream"`` bubble."""

    def __init__(self, req_id: str | None = None, stream_id: str | None = None):
        self.req_id = req_id
        self.stream_id = stream_id or _req_id("stream")
        self.turn = 0
        self.summary = ""
        self.text = ""
        self.tools: list[dict] = []
        self.done = False
        self.status = "running"
        self.error = ""
        self.last_push = 0.0

    def apply(self, name: str, data: dict):
        if name == "turn.start":
            self.turn = data.get("turn") or (self.turn + 1)
            self.summary = ""
            self.text = ""
            self.tools = []
        elif name == "assistant.text":
            raw = data.get("text") or ""
            s = _extract_summary(raw)
            if s:
                self.summary = s
            self.text = _clean_text(raw)
        elif name == "tool.call":
            tool_name = data.get("name") or "tool"
            self.tools.append({
                "id": data.get("id"),
                "name": tool_name,
                "arg": _tool_arg(tool_name, data.get("arguments")),
                "status": "running",
            })
        elif name == "tool.result":
            tid = data.get("id")
            item = next(
                (t for t in reversed(self.tools)
                 if (tid and t["id"] == tid) or t["status"] == "running"),
                None,
            )
            if item:
                item["status"] = data.get("status") or "success"
        elif name == "turn.end":
            for t in self.tools:
                if t["status"] == "running":
                    t["status"] = "success"

    def finish(self, text: str, status: str, error: str | None):
        self.done = True
        self.status = status or "done"
        self.error = error or ""
        cleaned = _clean_text(text)
        if cleaned:
            self.text = cleaned

    def render_progress(self, max_len: int = 3800) -> str:
        header = f"⏳ **Turn {self.turn or 1}**"
        if self.summary:
            header += f" · {self.summary}"
        parts = [header]
        if self.tools:
            lines = []
            for t in self.tools[-6:]:
                icon = "🔧" if t["status"] == "running" else ("❌" if t["status"] == "error" else "✅")
                arg = f" `{t['arg']}`" if t.get("arg") else ""
                lines.append(f"- {icon} **{t['name']}**{arg}")
            parts.append("\n".join(lines))
        if self.text:
            snippet = self.text.strip()
            if len(snippet) > max_len - 400:
                snippet = snippet[: max_len - 400] + "…"
            parts.append(snippet)
        return "\n\n".join(parts)[:max_len]

    def render_final(self) -> str:
        if self.text:
            return self.text
        if self.status == "aborted":
            return "⏹️ 已停止当前任务。"
        if self.status == "error":
            return f"❌ 运行出错：{self.error or '未知错误'}"
        return "✅ 任务已完成。"


# -- WeComAdapter -------------------------------------------------------------

class WeComAdapter(Adapter):
    max_len = 3800

    def __init__(self, name: str, bot_id: str, secret: str, allowed=None, *,
                 ws_url: str | None = None, log=None, on_dead=None,
                 conn_factory=None, downloader=download_media):
        self.name = name
        self.bot_id = bot_id
        self.secret = secret
        self.allowed = set(allowed) if allowed else None
        self.ws_url = (ws_url or "").strip() or WS_URL
        self.log = log or (lambda level, text: None)
        self.on_dead = on_dead
        self.conn_factory = conn_factory or (lambda url: WsConn(url))
        self.downloader = downloader

        self.lock = threading.Lock()
        self.conn: WsConn | None = None
        self.authenticated = threading.Event()
        self.stopping = threading.Event()
        self.thread: threading.Thread | None = None

        self.pending: dict[str, tuple[threading.Event, list]] = {}
        self.seen_msgids: deque[str] = deque(maxlen=500)
        self.chat_req_ids: dict[str, str] = {}
        self.streams: dict[tuple[str, str], TaskStream] = {}
        self.missed_pong = 0

    def start(self, hub):
        super().start(hub)
        self.stopping.clear()
        self.thread = threading.Thread(
            target=self._loop, name=f"wecom-{self.name}", daemon=True
        )
        self.thread.start()
        self.log("info", f"connecting to {self.ws_url} (bot_id={self.bot_id[:8]}...)")

    def stop(self):
        self.stopping.set()
        self.authenticated.clear()
        with self.lock:
            conn, self.conn = self.conn, None
        if conn is not None:
            conn.close()
        self._fail_pending("adapter stopped")
        if self.thread and self.thread.is_alive() and self.thread is not threading.current_thread():
            self.thread.join(timeout=3)
        self.log("info", "stopped")

    # -- WebSocket loop & framing ---------------------------------------------

    def _fail_pending(self, reason: str):
        with self.lock:
            items = list(self.pending.values())
            self.pending.clear()
        for ev, box in items:
            box.append({"errcode": -1, "errmsg": reason})
            ev.set()

    def _loop(self):
        delay = RECONNECT_BASE
        while not self.stopping.is_set():
            conn = None
            hb_stop = threading.Event()
            try:
                conn = self.conn_factory(self.ws_url)
                conn.connect()
                with self.lock:
                    self.conn = conn
                self.missed_pong = 0

                sub_id = _req_id(CMD_SUBSCRIBE)
                conn.send_json({
                    "cmd": CMD_SUBSCRIBE,
                    "headers": {"req_id": sub_id},
                    "body": {"bot_id": self.bot_id, "secret": self.secret},
                })
                first = conn.recv_json()
                errcode = first.get("errcode", 0)
                if errcode != 0:
                    errmsg = first.get("errmsg") or f"errcode {errcode}"
                    self.log("error", f"subscribe rejected ({errcode}): {errmsg}")
                    conn.close()
                    if self.on_dead and not self.stopping.is_set():
                        self.on_dead(f"WeCom auth failed ({errcode}): {errmsg}")
                    return

                self.authenticated.set()
                delay = RECONNECT_BASE
                self.log("info", "subscribed and ready")

                hb_thread = threading.Thread(
                    target=self._heartbeat_loop, args=(conn, hb_stop),
                    name=f"wecom-hb-{self.name}", daemon=True,
                )
                hb_thread.start()

                while not self.stopping.is_set():
                    frame = conn.recv_json()
                    if frame:
                        self._handle_frame(frame)
            except Exception as e:  # noqa: BLE001
                if self.stopping.is_set():
                    break
                self.authenticated.clear()
                self._fail_pending(str(e))
                self.log("warn", f"connection lost ({e}); retrying in {delay:.0f}s")
                self.stopping.wait(delay)
                delay = min(delay * 2, RECONNECT_MAX)
            finally:
                hb_stop.set()
                self.authenticated.clear()
                if conn is not None:
                    conn.close()
                with self.lock:
                    if self.conn is conn:
                        self.conn = None

    def _heartbeat_loop(self, conn: WsConn, stop_ev: threading.Event):
        while not stop_ev.wait(HEARTBEAT_INTERVAL) and not self.stopping.is_set():
            if self.missed_pong >= MAX_MISSED_PONG:
                self.log("warn", f"no pong for {self.missed_pong} pings; closing socket")
                conn.close()
                return
            try:
                self.missed_pong += 1
                conn.send_json({"cmd": CMD_PING, "headers": {"req_id": _req_id(CMD_PING)}})
            except Exception:  # noqa: BLE001
                conn.close()
                return

    def _handle_frame(self, frame: dict):
        cmd = frame.get("cmd") or ""
        headers = frame.get("headers") or {}
        req_id = headers.get("req_id") or ""

        if cmd == CMD_MSG_CALLBACK:
            threading.Thread(
                target=self._on_message, args=(req_id, frame.get("body") or {}),
                daemon=True,
            ).start()
            return

        if cmd == CMD_EVENT_CALLBACK:
            threading.Thread(
                target=self._on_event, args=(req_id, frame.get("body") or {}),
                daemon=True,
            ).start()
            return

        if req_id.startswith(f"{CMD_PING}_"):
            self.missed_pong = 0
            return

        with self.lock:
            waiter = self.pending.pop(req_id, None)
        if waiter is not None:
            ev, box = waiter
            box.append(frame)
            ev.set()

    def _request(self, cmd: str, body: dict | None = None, *,
                 req_id: str | None = None, timeout: float = 15.0) -> dict:
        if not self.authenticated.is_set():
            self.authenticated.wait(timeout=min(timeout, 5.0))
        with self.lock:
            conn = self.conn
        if conn is None or not self.authenticated.is_set():
            raise RuntimeError("WeCom WebSocket is not connected")

        rid = req_id or _req_id(cmd)
        ev = threading.Event()
        box: list[dict] = []
        with self.lock:
            self.pending[rid] = (ev, box)
        try:
            packet: dict = {"cmd": cmd, "headers": {"req_id": rid}}
            if body is not None:
                packet["body"] = body
            conn.send_json(packet)
            if not ev.wait(timeout):
                raise TimeoutError(f"WeCom {cmd} timed out after {timeout}s")
            resp = box[0] if box else {}
            errcode = resp.get("errcode", 0)
            if errcode != 0:
                errmsg = resp.get("errmsg") or f"errcode {errcode}"
                raise RuntimeError(f"WeCom {cmd} error ({errcode}): {errmsg}")
            return resp
        finally:
            with self.lock:
                self.pending.pop(rid, None)

    # -- Inbound callbacks ----------------------------------------------------

    def _on_message(self, req_id: str, body: dict):
        msgid = str(body.get("msgid") or "")
        with self.lock:
            if msgid:
                if msgid in self.seen_msgids:
                    return
                self.seen_msgids.append(msgid)

        sender = str((body.get("from") or {}).get("userid") or "")
        if not sender:
            return
        if self.allowed and sender not in self.allowed:
            self.log("warn", f"blocked message from unauthorized user {sender}")
            return

        chattype = body.get("chattype") or "single"
        chat_id = str(body.get("chatid") or sender) if chattype == "group" else sender
        if req_id:
            with self.lock:
                self.chat_req_ids[chat_id] = req_id

        text, files = extract_message(body, downloader=self.downloader, log=self.log)
        if not text and not files:
            return

        self.log(
            "info",
            f"message from {sender} in {chat_id}: {(text or '<media>')[:80]}"
            + (f" ({len(files)} file(s))" if files else ""),
        )
        if self.hub is not None:
            self.hub.receive(self.name, chat_id, text, user=sender, files=files)

    def _on_event(self, req_id: str, body: dict):
        ev = body.get("event") or {}
        etype = ev.get("eventtype") or ""
        sender = str((body.get("from") or {}).get("userid") or "")
        if self.allowed and sender and sender not in self.allowed:
            return
        if etype == "enter_chat" and req_id:
            try:
                self._request(
                    CMD_RESPOND_WELCOME,
                    {"msgtype": "text", "text": {"content": "👋 你好！直接发消息开始对话，或发送 /help 查看命令。"}},
                    req_id=req_id,
                    timeout=10.0,
                )
            except Exception as e:  # noqa: BLE001
                self.log("debug", f"welcome reply skipped: {e}")

    # -- Outbound messages, streaming & media upload --------------------------

    def _respond_stream(self, req_id: str, stream_id: str, content: str, finish: bool):
        return self._request(
            CMD_RESPOND_MSG,
            {
                "msgtype": "stream",
                "stream": {
                    "id": stream_id,
                    "finish": bool(finish),
                    "content": content or " ",
                },
            },
            req_id=req_id,
            timeout=15.0,
        )

    def _send_markdown(self, chat_id: str, content: str):
        return self._request(
            CMD_SEND_MSG,
            {
                "chatid": str(chat_id),
                "msgtype": "markdown",
                "markdown": {"content": content or " "},
            },
            timeout=15.0,
        )

    def send(self, chat_id, text):
        chat_id = str(chat_id)
        for chunk in split_text(text or "", self.max_len):
            with self.lock:
                req_id = self.chat_req_ids.pop(chat_id, None)
            if req_id:
                try:
                    self._respond_stream(req_id, _req_id("stream"), chunk, True)
                    continue
                except Exception as e:  # noqa: BLE001
                    self.log("debug", f"respond_stream fallback to send_msg: {e}")
            self._send_markdown(chat_id, chunk)

    def _get_stream(self, chat_id: str, run_id: str) -> TaskStream:
        key = (str(chat_id), str(run_id))
        with self.lock:
            stream = self.streams.get(key)
            if stream is None:
                if len(self.streams) >= 50:
                    del self.streams[next(iter(self.streams))]
                req_id = self.chat_req_ids.pop(str(chat_id), None)
                stream = TaskStream(req_id=req_id)
                self.streams[key] = stream
            return stream

    def progress(self, chat_id, run_id, name, data):
        stream = self._get_stream(str(chat_id), str(run_id))
        stream.apply(name, data or {})
        if not stream.req_id:
            return
        now = time.monotonic()
        important = name in ("turn.start", "tool.call", "turn.end")
        if not important and now - stream.last_push < UPDATE_GAP:
            return
        stream.last_push = now
        try:
            self._respond_stream(
                stream.req_id,
                stream.stream_id,
                stream.render_progress(self.max_len),
                False,
            )
        except Exception as e:  # noqa: BLE001
            self.log("debug", f"stream progress push failed: {e}")

    def finish(self, chat_id, run_id, text, status, error):
        chat_id = str(chat_id)
        stream = self._get_stream(chat_id, str(run_id))
        stream.finish(text or "", status or "done", error)
        final_text = stream.render_final()
        chunks = split_text(final_text, self.max_len) or [final_text]

        if stream.req_id:
            try:
                self._respond_stream(stream.req_id, stream.stream_id, chunks[0], True)
                for extra in chunks[1:]:
                    self._send_markdown(chat_id, extra)
                return
            except Exception as e:  # noqa: BLE001
                self.log("debug", f"stream finish fallback to send_msg: {e}")

        for chunk in chunks:
            self._send_markdown(chat_id, chunk)

    def upload_media(self, raw: bytes, filename: str, media_type: str) -> str:
        total_size = len(raw)
        if total_size == 0:
            raise ValueError("cannot upload empty file")
        if total_size > MAX_FILE_BYTES:
            raise ValueError(f"file too large ({total_size} bytes > 20 MB)")
        total_chunks = (total_size + CHUNK_SIZE - 1) // CHUNK_SIZE
        if total_chunks > MAX_CHUNKS:
            raise ValueError(f"file exceeds {MAX_CHUNKS} chunks")

        md5 = hashlib.md5(raw).hexdigest()
        init_res = self._request(
            CMD_UPLOAD_INIT,
            {
                "type": media_type,
                "filename": filename,
                "total_size": total_size,
                "total_chunks": total_chunks,
                "md5": md5,
            },
            timeout=30.0,
        )
        upload_id = (init_res.get("body") or {}).get("upload_id")
        if not upload_id:
            raise RuntimeError("upload_init did not return upload_id")

        for idx in range(total_chunks):
            chunk = raw[idx * CHUNK_SIZE : (idx + 1) * CHUNK_SIZE]
            b64 = base64.b64encode(chunk).decode("ascii")
            self._request(
                CMD_UPLOAD_CHUNK,
                {
                    "upload_id": upload_id,
                    "chunk_index": idx,
                    "base64_data": b64,
                },
                timeout=30.0,
            )

        fin_res = self._request(
            CMD_UPLOAD_FINISH,
            {"upload_id": upload_id},
            timeout=30.0,
        )
        media_id = (fin_res.get("body") or {}).get("media_id")
        if not media_id:
            raise RuntimeError("upload_finish did not return media_id")
        return media_id

    def send_file(self, chat_id, path):
        with open(path, "rb") as f:
            raw = f.read()
        name = os.path.basename(path)
        ext = os.path.splitext(name)[1].lower()
        if ext in IMAGE_EXTS:
            mtype = "image"
        elif ext in VIDEO_EXTS:
            mtype = "video"
        elif ext in VOICE_EXTS:
            mtype = "voice"
        else:
            mtype = "file"
        media_id = self.upload_media(raw, name, mtype)
        self._request(
            CMD_SEND_MSG,
            {
                "chatid": str(chat_id),
                "msgtype": mtype,
                mtype: {"media_id": media_id},
            },
            timeout=15.0,
        )


def _allowed(cfg: dict) -> list[str] | None:
    raw = cfg.get("allowed_users") or ""
    if isinstance(raw, str):
        raw = [x.strip() for x in raw.split(",") if x.strip()]
    return [str(x) for x in raw] or None


def apply(ctx, config):
    manager = ctx.get("channel_manager")

    def factory(cid, cfg, log):
        bot_id = (cfg.get("bot_id") or "").strip()
        secret = (cfg.get("secret") or "").strip()
        if not (bot_id and secret):
            raise RuntimeError("bot_id and secret are required")
        return WeComAdapter(
            cid,
            bot_id,
            secret,
            _allowed(cfg),
            ws_url=cfg.get("ws_url"),
            log=log,
            on_dead=lambda err: manager.fail(cid, err),
        )

    return manager.register_provider(
        Provider(
            "wecom",
            factory,
            label="WeCom",
            label_zh="企业微信",
            fields=FIELDS,
        )
    )
