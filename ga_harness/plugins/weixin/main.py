"""WeChat (iLink bot) channel provider.

Login is a QR scan (``pair``): the confirmed scan yields a bot token that is
stored in the channel config. A running channel long-polls ``getupdates`` and
replies with ``sendmessage``; replies need the latest ``context_token`` seen
from that user, so only users who have messaged the bot can be answered.
Protocol follows tasercake/pi-connect (platform/weixin). Images, files and
videos travel through the WeChat CDN, AES-128-ECB encrypted (needs
``pycryptodome`` or ``cryptography``).
"""
import base64
import hashlib
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from ga_harness.channel_manager import Provider
from ga_harness.channels import Adapter

API = "https://ilinkai.weixin.qq.com/"
VERSION = "ga-harness-weixin/1.0"
BOT_TYPE = "3"
SESSION_EXPIRED = -14
ITEM_TEXT, ITEM_IMAGE, ITEM_VOICE, ITEM_FILE, ITEM_VIDEO = 1, 2, 3, 4, 5
CDN = "https://novac2c.cdn.weixin.qq.com/c2c"
MEDIA_IMAGE, MEDIA_VIDEO, MEDIA_FILE = 1, 2, 3
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v"}
MAX_MEDIA = 100 << 20
TYPE_USER, TYPE_BOT, STATE_FINISH = 1, 2, 2

FIELDS = [
    {"key": "token", "label": "Bot token (filled by QR login)",
     "label_zh": "\u673a\u5668\u4eba token\uff08\u626b\u7801\u81ea\u52a8\u586b\u5199\uff09",
     "required": True, "secret": True},
    {"key": "account_id", "label": "Bot account id", "label_zh": "\u673a\u5668\u4eba\u8d26\u53f7 ID"},
    {"key": "base_url", "label": "API base URL (empty = default)",
     "label_zh": "API \u5730\u5740\uff08\u7559\u7a7a\u4e3a\u9ed8\u8ba4\uff09"},
    {"key": "allowed_users", "label": "Allowed user ids, comma separated (empty = everyone)",
     "label_zh": "\u5141\u8bb8\u7684\u7528\u6237 ID\uff0c\u9017\u53f7\u5206\u9694\uff08\u7559\u7a7a\u4e3a\u6240\u6709\u4eba\uff09"},
]


def _base(url):
    url = (url or "").strip() or API
    return url if url.endswith("/") else url + "/"


def _uin():
    n = int.from_bytes(os.urandom(4), "big")
    return base64.b64encode(str(n).encode()).decode()


def _aes(key, data, encrypt):
    try:
        from Crypto.Cipher import AES
        c = AES.new(key, AES.MODE_ECB)
        return c.encrypt(data) if encrypt else c.decrypt(data)
    except ImportError:
        pass
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    except ImportError:
        raise RuntimeError("WeChat media needs pycryptodome or cryptography installed") from None
    c = Cipher(algorithms.AES(key), modes.ECB())
    op = c.encryptor() if encrypt else c.decryptor()
    return op.update(data) + op.finalize()


def encrypt(key, raw):
    n = 16 - len(raw) % 16
    return _aes(key, raw + bytes([n]) * n, True)


def decrypt(key, data):
    raw = _aes(key, data, False)
    n = raw[-1] if raw else 0
    if not 1 <= n <= 16 or raw[-n:] != bytes([n]) * n:
        raise ValueError("bad padding (wrong AES key?)")
    return raw[:-n]


def parse_key(media, hex_key=""):
    """AES key of an inbound item: ``aeskey`` hex, or ``aes_key`` base64 of the
    16 raw bytes or of their 32-char hex text."""
    if hex_key:
        return bytes.fromhex(hex_key)
    raw = base64.b64decode((media or {}).get("aes_key") or "")
    if len(raw) == 32:
        raw = bytes.fromhex(raw.decode("ascii"))
    if len(raw) != 16:
        raise ValueError("missing or invalid AES key")
    return raw


def _http(url, data=None, timeout=60):
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET",
                                 headers={"Content-Type": "application/octet-stream"} if data else {})
    return urllib.request.urlopen(req, timeout=timeout)


def _get(url, timeout):
    req = urllib.request.Request(url, headers={"iLink-App-ClientVersion": "1"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read(1 << 20) or b"{}")


class Api:
    def __init__(self, base_url, token):
        self.base, self.token = _base(base_url), token

    def post(self, endpoint, payload, timeout=15):
        body = json.dumps(dict(payload, base_info={"channel_version": VERSION})).encode()
        req = urllib.request.Request(self.base + endpoint, data=body, method="POST", headers={
            "Content-Type": "application/json", "AuthorizationType": "ilink_bot_token",
            "Authorization": "Bearer " + self.token, "X-WECHAT-UIN": _uin()})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(4 << 20)
        return json.loads(raw) if raw.strip() else {}

    def download(self, media, hex_key=""):
        """Fetch and decrypt one CDN media blob."""
        q = (media or {}).get("encrypt_query_param")
        if not q:
            raise ValueError("media has no download parameter")
        url = CDN + "/download?encrypted_query_param=" + urllib.parse.quote(q, safe="")
        with _http(url) as resp:
            data = resp.read(MAX_MEDIA + 1024)
        return decrypt(parse_key(media, hex_key), data)

    def upload(self, raw, to, media_type):
        """Encrypt + upload a blob; returns (media dict, cipher size)."""
        key, filekey = os.urandom(16), os.urandom(16).hex()
        cipher = encrypt(key, raw)
        res = self.post("ilink/bot/getuploadurl", {
            "filekey": filekey, "media_type": media_type, "to_user_id": to,
            "rawsize": len(raw), "rawfilemd5": hashlib.md5(raw).hexdigest(),
            "filesize": len(cipher), "no_need_thumb": True, "aeskey": key.hex()})
        if res.get("ret") or res.get("errcode"):
            raise RuntimeError(f"getuploadurl failed: {res.get('errcode') or res.get('ret')} "
                               f"{res.get('errmsg', '')}")
        url = res.get("upload_full_url")
        if not url:
            if not res.get("upload_param"):
                raise RuntimeError("getuploadurl returned no upload url")
            url = (CDN + "/upload?encrypted_query_param="
                   + urllib.parse.quote(res["upload_param"], safe="")
                   + "&filekey=" + urllib.parse.quote(filekey, safe=""))
        with _http(url, cipher, timeout=120) as resp:
            param = resp.headers.get("x-encrypted-param")
        if not param:
            raise RuntimeError("CDN upload returned no download parameter")
        media = {"encrypt_query_param": param,
                 "aes_key": base64.b64encode(key.hex().encode()).decode(), "encrypt_type": 1}
        return media, len(cipher)

    def send_items(self, to, items, context_token):
        for item in items:
            self._send(to, [item], context_token)

    def get_updates(self, buf, timeout=40):
        return self.post("ilink/bot/getupdates", {"get_updates_buf": buf}, timeout)

    def send_text(self, to, text, context_token):
        msg = {"from_user_id": "", "to_user_id": to, "client_id": "gah-" + uuid.uuid4().hex,
               "message_type": TYPE_BOT, "message_state": STATE_FINISH,
               "item_list": [{"type": ITEM_TEXT, "text_item": {"text": text}}],
               "context_token": context_token}
        self._post_msg(msg)

    def _send(self, to, items, context_token):
        self._post_msg({"from_user_id": "", "to_user_id": to, "client_id": "gah-" + uuid.uuid4().hex,
                        "message_type": TYPE_BOT, "message_state": STATE_FINISH,
                        "item_list": items, "context_token": context_token})

    def _post_msg(self, msg):
        res = self.post("ilink/bot/sendmessage", {"msg": msg})
        if res.get("ret") or res.get("errcode"):
            raise RuntimeError(f"sendmessage failed: {res.get('errcode') or res.get('ret')} "
                               f"{res.get('errmsg', '')}")


def pair(update, cancelled):
    """QR login: returns {token, account_id, base_url} once confirmed."""
    refreshes = 0
    while True:
        q = _get(API + "ilink/bot/get_bot_qrcode?bot_type=" + BOT_TYPE, 15)
        code, content = q.get("qrcode"), q.get("qrcode_img_content")
        if not (code and content):
            raise RuntimeError("failed to fetch QR code")
        update(status="wait", qr=content, text="Scan with WeChat")
        deadline = time.time() + 480
        while time.time() < deadline:
            if cancelled():
                raise RuntimeError("cancelled")
            try:
                st = _get(API + "ilink/bot/get_qrcode_status?qrcode="
                          + urllib.parse.quote(code), 40)
            except (TimeoutError, urllib.error.URLError) as e:
                if "timed out" in str(e):
                    continue  # long poll expired without change
                raise
            status = st.get("status")
            if status == "scaned":
                update(status="scanned", text="Scanned, confirm on the phone")
            elif status == "confirmed":
                if not st.get("bot_token"):
                    raise RuntimeError("login confirmed but no bot token returned")
                return {"token": st["bot_token"], "account_id": st.get("ilink_bot_id") or "",
                        "base_url": st.get("baseurl") or "",
                        "allowed_users": st.get("ilink_user_id") or ""}
            elif status == "expired":
                break
            if cancelled():
                raise RuntimeError("cancelled")
            time.sleep(1)
        refreshes += 1
        if refreshes > 3:
            raise RuntimeError("QR code expired")
        update(status="wait", text="QR code expired, refreshed")


def _media_items(msg):
    """[(media, hex_key, file name)] for image/file/video items."""
    out = []
    for item in msg.get("item_list") or []:
        t = item.get("type")
        if t == ITEM_IMAGE:
            img = item.get("image_item") or {}
            out.append((img.get("media"), img.get("aeskey") or "", "image.jpg"))
        elif t == ITEM_FILE:
            f = item.get("file_item") or {}
            out.append((f.get("media"), "", f.get("file_name") or "file"))
        elif t == ITEM_VIDEO:
            out.append(((item.get("video_item") or {}).get("media"), "", "video.mp4"))
    return out


def _text(msg):
    parts = []
    for item in msg.get("item_list") or []:
        if item.get("type") == ITEM_TEXT:
            parts.append((item.get("text_item") or {}).get("text") or "")
        elif item.get("type") == ITEM_VOICE:
            parts.append((item.get("voice_item") or {}).get("text") or "")
    return "\n".join(p for p in parts if p).strip()


class WeixinAdapter(Adapter):
    max_len = 2000

    def __init__(self, name, api, allowed=(), log=None, on_dead=None):
        self.name, self.api = name, api
        self.allowed = set(allowed)
        self.log = log or (lambda level, text: None)
        self.on_dead = on_dead
        self.contexts, self.lock = {}, threading.Lock()
        self.stopping = threading.Event()
        self.thread = None

    def start(self, hub):
        super().start(hub)
        self.thread = threading.Thread(target=self._loop, name=f"weixin-{self.name}", daemon=True)
        self.thread.start()

    def stop(self):
        self.stopping.set()

    def _loop(self):
        buf, failures = "", 0
        while not self.stopping.is_set():
            try:
                res = self.api.get_updates(buf)
            except (TimeoutError, urllib.error.URLError, OSError, ValueError) as e:
                if "timed out" in str(e):
                    continue
                failures += 1
                self.log("warn", f"getupdates failed ({failures}): {e}")
                self.stopping.wait(min(30, 2 * failures))
                continue
            if res.get("errcode") == SESSION_EXPIRED or res.get("ret") == SESSION_EXPIRED:
                if self.on_dead and not self.stopping.is_set():
                    self.on_dead("WeChat session expired, scan the QR code again")
                return
            if res.get("ret") or res.get("errcode"):
                failures += 1
                self.log("warn", f"getupdates error {res.get('errcode') or res.get('ret')}: "
                                 f"{res.get('errmsg', '')}")
                self.stopping.wait(min(30, 2 * failures))
                continue
            failures = 0
            buf = res.get("get_updates_buf") or buf
            for msg in res.get("msgs") or []:
                try:
                    self.handle(msg)
                except Exception as e:  # noqa: BLE001 - one bad message must not kill the loop
                    self.log("error", f"message handling failed: {e}")

    def handle(self, msg):
        if msg.get("message_type") != TYPE_USER:
            return
        user = msg.get("from_user_id") or ""
        if not user:
            return
        if msg.get("context_token"):
            with self.lock:
                self.contexts[user] = msg["context_token"]
        if self.allowed and user not in self.allowed:
            self.log("info", f"ignored message from {user} (not allowed)")
            return
        text, files = _text(msg), []
        for media, hex_key, name in _media_items(msg):
            try:
                files.append({"name": name, "data": self.api.download(media, hex_key)})
            except Exception as e:  # noqa: BLE001
                self.log("error", f"media download failed ({name}): {e}")
        if text or files:
            self.log("info", f"message from {user}"
                             + (f" with {len(files)} file(s)" if files else ""))
            self.hub.receive(self.name, user, text, user=user, files=files)

    def _token(self, chat_id):
        with self.lock:
            token = self.contexts.get(chat_id)
        if not token:
            raise RuntimeError(f"no context token for {chat_id}; the user must message first")
        return token

    def send(self, chat_id, text):
        token = self._token(chat_id)
        self.api.send_text(chat_id, text, token)

    def send_file(self, chat_id, path):
        token = self._token(chat_id)
        with open(path, "rb") as f:
            raw = f.read(MAX_MEDIA + 1)
        if len(raw) > MAX_MEDIA:
            raise RuntimeError("file too large")
        ext, name = os.path.splitext(path)[1].lower(), os.path.basename(path)
        if ext in IMAGE_EXTS:
            media, size = self.api.upload(raw, chat_id, MEDIA_IMAGE)
            item = {"type": ITEM_IMAGE, "image_item": {"media": media, "mid_size": size}}
        elif ext in VIDEO_EXTS:
            media, size = self.api.upload(raw, chat_id, MEDIA_VIDEO)
            item = {"type": ITEM_VIDEO, "video_item": {"media": media, "video_size": size}}
        else:
            media, _ = self.api.upload(raw, chat_id, MEDIA_FILE)
            item = {"type": ITEM_FILE, "file_item": {"media": media, "file_name": name,
                                                     "len": str(len(raw))}}
        self.api.send_items(chat_id, [item], token)


def _allowed(cfg):
    return [u.strip() for u in (cfg.get("allowed_users") or "").split(",") if u.strip()]


def apply(ctx, config):
    manager = ctx.get("channel_manager")

    def factory(cid, cfg, log):
        token = (cfg.get("token") or "").strip()
        if not token:
            raise RuntimeError("bot token missing; use QR login")
        return WeixinAdapter(cid, Api(cfg.get("base_url"), token), _allowed(cfg), log=log,
                             on_dead=lambda err: manager.fail(cid, err))

    return manager.register_provider(Provider(
        "weixin", factory, label="WeChat", label_zh="\u5fae\u4fe1", fields=FIELDS, pair=pair))
