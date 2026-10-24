"""Model endpoints use synthetic keys and an isolated loopback server."""
import json

from tests.test_models import make_models
from tests.test_ui_web import _start, _req, _wait_idle


def test_model_http_roundtrip_busy_and_errors(tmp_path):
    rt, fe, off, base = _start(tmp_path)
    fe.models = make_models(tmp_path)
    try:
        status, state = _req(base + "api/state")
        assert status == 200 and state["models"]["current"] == 0
        status, cfg = _req(base + "api/models/config")
        assert status == 200 and cfg["writable"]
        assert "test-secret" not in json.dumps(cfg)
        body = {"action": "save", "key": "native_claude_config_two",
                "revision": cfg["revision"], "values": {
                    "name": "Two", "model": "test-two", "apikey": "http-synthetic-key",
                    "apibase": "https://example.invalid/v1"}}
        assert _req(base + "api/models/config", body, {"Origin": "https://foreign.invalid"})[0] == 403
        status, saved = _req(base + "api/models/config", body)
        assert status == 200 and len(saved["state"]["models"]["items"]) == 2
        assert "http-synthetic-key" not in json.dumps(saved)
        assert _req(base + "api/models/config", body)[0] == 409
        assert _req(base + "api/models/select", {"id": 1})[1]["models"]["current"] == 1
        assert _req(base + "api/models/select", {"id": True})[0] == 400
        original = fe.models.source.file.read_bytes()
        assert _req(base + "api/run", {"task": "wait"})[0] == 202
        assert _req(base + "api/models/select", {"id": 0})[0] == 409
        body["revision"] = saved["config"]["revision"]
        assert _req(base + "api/models/config", body)[0] == 409
        assert fe.models.source.file.read_bytes() == original
        assert _req(base + "api/abort", {})[0] == 202
        assert not _wait_idle(base)["running"]
        assert _req(base + "api/models/select", {"id": 0})[0] == 200
        body.update(action="delete")
        status, deleted = _req(base + "api/models/config", body)
        assert status == 200 and len(deleted["config"]["entries"]) == 1
    finally:
        off()
        rt.dispose()
