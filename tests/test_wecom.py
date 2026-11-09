"""Tests for the built-in WeCom (Enterprise WeChat AI Bot) channel plugin."""
from __future__ import annotations

import base64
import hashlib
import importlib.util
from pathlib import Path

from ga_harness.channel_manager import ChannelManager, ChannelStore
from ga_harness.channels import Bindings, Hub


def _load_wecom():
    path = Path(__file__).resolve().parents[1] / "ga_harness" / "plugins" / "wecom" / "main.py"
    spec = importlib.util.spec_from_file_location("gah_wecom_main", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeRuns:
    def __init__(self):
        self.started = []
        self.active = {}

    def start(self, task, *, session_id=None, source="user", timeout=None, attachments=None):
        run = {
            "id": f"r{len(self.started) + 1}",
            "session_id": session_id,
            "source": source,
            "attachments": attachments,
        }
        self.started.append((task, run))
        return run

    def active_for(self, sid):
        return self.active.get(sid)

    def cancel(self, run_id):
        return True


class FakeSessions:
    def __init__(self):
        self.items = {}

    def create(self, **kw):
        sid = f"s{len(self.items) + 1}"
        self.items[sid] = {"id": sid, **kw}
        return self.items[sid]

    def get(self, sid):
        return self.items.get(sid)

    def remember_for(self, sid, **values):
        self.items[sid]["state"] = {**(self.items[sid].get("state") or {}), **values}

    def listing(self):
        return list(self.items.values())


def test_decrypt_media_aes256_cbc():
    mod = _load_wecom()
    key = bytes(range(32))
    # 43-char Base64 without trailing '=' (standard WeCom aeskey format)
    aes_key_b64 = base64.b64encode(key).decode("ascii").rstrip("=")
    plaintext = b"Enterprise WeChat encrypted image payload!"
    pad_len = 32 - (len(plaintext) % 32)
    padded = plaintext + bytes([pad_len]) * pad_len

    from Crypto.Cipher import AES

    ciphertext = AES.new(key, AES.MODE_CBC, iv=key[:16]).encrypt(padded)

    assert mod.decrypt_media(ciphertext, aes_key_b64) == plaintext


def test_extract_message_types_and_quote():
    mod = _load_wecom()

    def fake_downloader(url, aes_key=None):
        return f"data:{url}:{aes_key}".encode("utf-8"), "pic.png"

    # Group text strips leading @mention and includes quoted text
    text, files = mod.extract_message(
        {
            "msgtype": "text",
            "chattype": "group",
            "text": {"content": "@Robot 帮我总结一下"},
            "quote": {"msgtype": "text", "text": {"content": "前文内容"}},
        },
        downloader=fake_downloader,
    )
    assert text == "[引用: 前文内容]\n帮我总结一下"
    assert files == []

    # Mixed message with text + encrypted image
    text2, files2 = mod.extract_message(
        {
            "msgtype": "mixed",
            "chattype": "single",
            "mixed": {
                "msg_item": [
                    {"msgtype": "text", "text": {"content": "看这张图"}},
                    {"msgtype": "image", "image": {"url": "https://cdn/1", "aeskey": "k1"}},
                ]
            },
        },
        downloader=fake_downloader,
    )
    assert text2 == "看这张图"
    assert len(files2) == 1
    assert files2[0]["name"] == "pic.png"
    assert files2[0]["data"] == b"data:https://cdn/1:k1"


def test_adapter_inbound_streaming_and_media_upload(tmp_path):
    mod = _load_wecom()
    hub = Hub(FakeRuns(), FakeSessions(), Bindings(tmp_path / "channels.db"))
    adapter = mod.WeComAdapter("wecom-1", "aib_test", "sec_test", {"u_allowed"})
    adapter.hub = hub

    sent_cmds = []

    def fake_request(cmd, body=None, *, req_id=None, timeout=15.0):
        sent_cmds.append((cmd, body, req_id))
        if cmd == mod.CMD_UPLOAD_INIT:
            return {"errcode": 0, "body": {"upload_id": "up_123"}}
        if cmd == mod.CMD_UPLOAD_CHUNK:
            return {"errcode": 0}
        if cmd == mod.CMD_UPLOAD_FINISH:
            return {"errcode": 0, "body": {"media_id": "media_999"}}
        return {"errcode": 0}

    adapter._request = fake_request

    try:
        # Unauthorized user is ignored
        adapter._on_message(
            "req_blocked",
            {
                "msgid": "m1",
                "chattype": "single",
                "from": {"userid": "u_stranger"},
                "msgtype": "text",
                "text": {"content": "hi"},
            },
        )
        assert hub.runs.started == []

        # Allowed user starts a run and records req_id for streaming
        adapter._on_message(
            "req_ok",
            {
                "msgid": "m2",
                "chattype": "single",
                "from": {"userid": "u_allowed"},
                "msgtype": "text",
                "text": {"content": "你好"},
            },
        )
        # Duplicate msgid is ignored
        adapter._on_message(
            "req_dup",
            {
                "msgid": "m2",
                "chattype": "single",
                "from": {"userid": "u_allowed"},
                "msgtype": "text",
                "text": {"content": "你好"},
            },
        )
        assert len(hub.runs.started) == 1
        run_id = hub.runs.started[0][1]["id"]

        # Progress + finish stream via aibot_respond_msg using req_ok
        adapter.progress("u_allowed", run_id, "turn.start", {"turn": 1})
        adapter.progress(
            "u_allowed",
            run_id,
            "tool.call",
            {"call_id": "c1", "name": "file_read", "arguments": {"path": "README.md"}},
        )
        adapter.finish("u_allowed", run_id, "<summary>ok</summary>最终回复内容", "done", None)

        respond_calls = [c for c in sent_cmds if c[0] == mod.CMD_RESPOND_MSG]
        assert respond_calls
        last_cmd, last_body, last_req = respond_calls[-1]
        assert last_req == "req_ok"
        assert last_body["msgtype"] == "stream"
        assert last_body["stream"]["finish"] is True
        assert last_body["stream"]["content"] == "最终回复内容"

        # Proactive send_file uploads chunks and sends media message
        sample = tmp_path / "report.pdf"
        payload = b"PDF-CONTENT-12345"
        sample.write_bytes(payload)
        sent_cmds.clear()
        adapter.send_file("u_allowed", str(sample))

        cmds_order = [c[0] for c in sent_cmds]
        assert cmds_order == [
            mod.CMD_UPLOAD_INIT,
            mod.CMD_UPLOAD_CHUNK,
            mod.CMD_UPLOAD_FINISH,
            mod.CMD_SEND_MSG,
        ]
        init_body = sent_cmds[0][1]
        assert init_body["type"] == "file"
        assert init_body["total_size"] == len(payload)
        assert init_body["md5"] == hashlib.md5(payload).hexdigest()
        file_msg = sent_cmds[3][1]
        assert file_msg == {
            "chatid": "u_allowed",
            "msgtype": "file",
            "file": {"media_id": "media_999"},
        }
    finally:
        hub.close()


def test_plugin_registers_wecom_provider(tmp_path):
    mod = _load_wecom()
    hub = Hub(FakeRuns(), FakeSessions(), Bindings(tmp_path / "channels.db"))
    mgr = ChannelManager(hub, ChannelStore(tmp_path / "channels.json"))

    from ga_harness.kernel.loader import discover
    from ga_harness.kernel.plugin import Runtime

    manifest = discover([Path(__file__).resolve().parents[1] / "ga_harness" / "plugins"])["wecom"]
    assert manifest.inject == ["channel_manager"]
    assert manifest.category == "service"
    assert "pycryptodome>=3.19" in manifest.packages
    runtime = Runtime()
    runtime.ctx.provide("channel_manager", mgr)
    try:
        dispose = runtime.add(manifest.to_plugin())
        assert runtime.handles["wecom"].state == "active"
        providers = {p["kind"]: p for p in mgr.snapshot()["providers"]}
        assert "wecom" in providers
        assert providers["wecom"]["label_zh"] == "企业微信"
        adapter = mgr.providers["wecom"].factory(
            "wecom-test", {"bot_id": "aib_test", "secret": "sec_test"}, lambda *args: None,
        )
        assert adapter.name == "wecom-test"
        assert adapter.bot_id == "aib_test"
        dispose()
        assert "wecom" not in mgr.providers
    finally:
        runtime.dispose()
        hub.close()
