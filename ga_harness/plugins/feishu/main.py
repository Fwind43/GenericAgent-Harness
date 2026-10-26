"""Feishu/Lark adapter for the channels hub (long-connection bot).

Credentials: env GAH_FEISHU_APP_ID / GAH_FEISHU_APP_SECRET, else settings.
``lark-oapi`` is imported lazily so the plugin loads without it.
"""
import asyncio
import json
import os
import re
import threading
from collections import OrderedDict

from ga_harness.channels import Adapter


def _cred(config, key, env):
    return (os.environ.get(env) or (config or {}).get(key) or "").strip()


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


class FeishuAdapter(Adapter):
    name = "feishu"
    max_len = 4000

    def __init__(self, app_id, app_secret, allowed=()):
        self.app_id, self.app_secret = app_id, app_secret
        self.allowed = set(allowed)
        self.seen, self.lock = OrderedDict(), threading.Lock()
        self.client = self.thread = None

    def claim(self, message_id):
        """True the first time a message id is seen (Feishu redelivers)."""
        with self.lock:
            if not message_id or message_id in self.seen:
                return not message_id
            self.seen[message_id] = True
            while len(self.seen) > 1000:
                self.seen.popitem(last=False)
            return True

    def handle(self, data):
        msg, sender = data.event.message, data.event.sender
        if not self.claim(getattr(msg, "message_id", "")):
            return
        user = getattr(sender.sender_id, "open_id", "") or ""
        if self.allowed and user not in self.allowed:
            return
        text = re.sub(r"@_user_\d+\s*", "", message_text(msg.message_type, msg.content)).strip()
        if text:
            self.hub.receive(self.name, msg.chat_id, text, user=user)

    def start(self, hub):
        super().start(hub)
        import lark_oapi as lark
        self.client = lark.Client.builder().app_id(self.app_id) \
            .app_secret(self.app_secret).build()
        handler = lark.EventDispatcherHandler.builder("", "") \
            .register_p2_im_message_receive_v1(self.handle).build()
        self.thread = threading.Thread(target=self._listen, args=(lark, handler),
                                       name="gah-feishu-ws", daemon=True)
        self.thread.start()

    def _listen(self, lark, handler):
        # lark's ws client keeps a module-level loop; give this thread its own.
        import lark_oapi.ws.client as wsc
        wsc.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(wsc.loop)
        lark.ws.Client(self.app_id, self.app_secret, event_handler=handler,
                       log_level=lark.LogLevel.WARNING).start()

    def send(self, chat_id, text):
        from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody
        body = CreateMessageRequestBody.builder().receive_id(chat_id).msg_type("text") \
            .content(json.dumps({"text": text}, ensure_ascii=False)).build()
        req = CreateMessageRequest.builder().receive_id_type("chat_id") \
            .request_body(body).build()
        resp = self.client.im.v1.message.create(req)
        if not resp.success():
            raise RuntimeError(f"feishu send failed: {resp.code} {resp.msg}")

    def stop(self):
        # lark's ws client has no public stop; the daemon thread ends with the process.
        self.client = None


def apply(ctx, config):
    app_id = _cred(config, "app_id", "GAH_FEISHU_APP_ID")
    app_secret = _cred(config, "app_secret", "GAH_FEISHU_APP_SECRET")
    if not (app_id and app_secret):
        raise RuntimeError("feishu: set app_id/app_secret (or GAH_FEISHU_APP_ID/SECRET)")
    try:
        import lark_oapi  # noqa: F401
    except ImportError as e:
        raise RuntimeError("feishu: pip install lark-oapi") from e
    adapter = FeishuAdapter(app_id, app_secret, _allowed(config))
    return ctx.get("channels").register(adapter)
