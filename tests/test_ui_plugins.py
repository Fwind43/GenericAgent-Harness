"""Plugin HTTP API on an isolated server; never imports GA or uses real keys."""
import json

from tests.test_plugin_manager import make_manager, item
from tests.test_ui_web import _start, _req, _wait_idle


def test_plugin_http_persistence_conflicts_busy_and_errors(tmp_path):
    rt, fe, off, base = _start(tmp_path)
    manager_rt, manager = make_manager(tmp_path)
    try:
        assert _req(base + "api/plugins")[0] == 404
        assert _req(base + "api/plugins", {})[0] == 404
        fe.plugins = manager
        assert _req(base + "api/state")[1]["plugins_enabled"] is True
        status, cfg = _req(base + "api/plugins")
        assert status == 200
        assert "DO-NOT-EXPOSE" not in json.dumps(cfg)
        body = {"action": "save", "name": "demo", "enabled": True,
                "revision": cfg["revision"], "config": {"limit": 22}}
        assert _req(base + "api/plugins", body, {"Origin": "https://foreign.invalid"})[0] == 403
        assert not manager.preferences.path.exists()
        status, saved = _req(base + "api/plugins", body)
        assert status == 200 and saved["restart_required"]
        assert item(saved)["config"]["limit"] == 22
        assert "DO-NOT-EXPOSE" not in json.dumps(saved)
        raw = manager.preferences.path.read_bytes()
        assert _req(base + "api/plugins", body)[0] == 409
        body["revision"] = saved["revision"]
        assert _req(base + "api/plugins", {**body, "name": "ga-core"})[0] == 400
        assert _req(base + "api/plugins", {**body, "name": "ga-hooks", "enabled": False, "config": {}})[0] == 409
        assert _req(base + "api/plugins", {**body, "config": {"secret": "not-public"}})[0] == 400
        assert _req(base + "api/plugins", {**body, "config": {"limit": True}})[0] == 400
        assert _req(base + "api/plugins", [body])[0] == 400
        assert manager.preferences.path.read_bytes() == raw
        assert _req(base + "api/run", {"task": "wait"})[0] == 202
        assert _req(base + "api/plugins")[0] == 200  # read-only while busy
        assert _req(base + "api/plugins", {**body, "enabled": False})[0] == 409
        assert manager.preferences.path.read_bytes() == raw
        assert _req(base + "api/abort", {})[0] == 202
        assert not _wait_idle(base)["running"]
        status, saved = _req(base + "api/plugins", {**body, "enabled": False})
        assert status == 200 and not item(saved)["enabled"]
        assert _req(base + "api/plugins")[1]["revision"] == saved["revision"]
        status, restored = _req(base + "api/plugins", {"action": "reset", "name": "demo", "revision": saved["revision"]})
        assert status == 200 and not item(restored)["overridden"]
        assert item(restored)["config"]["limit"] == 10
    finally:
        off()
        rt.dispose()
        manager_rt.dispose()


def test_plugin_http_storage_errors_are_redacted(tmp_path):
    rt, fe, off, base = _start(tmp_path)
    manager_rt, manager = make_manager(tmp_path)
    fe.plugins = manager
    try:
        cfg = manager.catalog()
        manager.preferences.path.write_text("SYNTHETIC-PRIVATE-INVALID-JSON", encoding="utf-8")
        status, result = _req(base + "api/plugins")
        assert status == 503 and "PRIVATE" not in json.dumps(result)
        status, result = _req(base + "api/plugins", {
            "name": "demo", "enabled": True, "revision": cfg["revision"]})
        assert status == 400 and "PRIVATE" not in json.dumps(result)
        assert manager.preferences.path.read_text() == "SYNTHETIC-PRIVATE-INVALID-JSON"
    finally:
        off()
        rt.dispose()
        manager_rt.dispose()
