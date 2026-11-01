"""ChannelManager: CRUD, write-only secrets, lifecycle and QR pairing.

Uses a minimal fake hub; no real adapter, platform or model is involved.
"""
import json
import time

import pytest

from ga_harness.channel_manager import ChannelManager, ChannelStore, Provider, resolve


class FakeHub:
    def __init__(self):
        self.adapters = {}
        self.disposed = []

    def register(self, adapter):
        self.adapters[adapter] = True

        def dispose():
            self.adapters.pop(adapter, None)
            self.disposed.append(adapter)
        return dispose


FIELDS = [{"key": "app_id", "required": True},
          {"key": "secret", "secret": True, "required": True},
          {"key": "note"}]


def make(tmp_path, *, factory=None, pair=None, register=True):
    hub = FakeHub()
    store = ChannelStore(tmp_path / "channels.json")
    m = ChannelManager(hub, store)
    built = []

    def default_factory(cid, cfg, log):
        built.append((cid, dict(cfg)))
        return cid

    p = Provider("demo", factory or default_factory, fields=FIELDS, pair=pair)
    dispose = m.register_provider(p) if register else None
    return m, hub, store, built, p, dispose


def stored(store):
    return {c["id"]: c for c in json.loads(store.path.read_text("utf-8"))["channels"]}


def test_provider_kind_validated():
    with pytest.raises(ValueError):
        Provider("Bad Kind", lambda *a: None)


def test_resolve_env(monkeypatch):
    monkeypatch.setenv("GAH_TEST_SECRET", "s3")
    assert resolve("env:GAH_TEST_SECRET") == "s3"
    assert resolve("env:GAH_TEST_MISSING_X") == ""
    assert resolve("plain") == "plain" and resolve(5) == 5


def test_secrets_are_write_only_and_kept_on_empty_update(tmp_path):
    m, _, store, _, _, _ = make(tmp_path)
    v = m.create({"provider": "demo", "id": "Ch1",
                  "config": {"app_id": " a ", "secret": "x", "unknown": "drop"}})
    assert v["id"] == "ch1"
    assert v["config"] == {"app_id": "a"} and v["secrets_set"] == ["secret"]
    assert stored(store)["ch1"]["config"] == {"app_id": "a", "secret": "x"}

    v = m.update("ch1", {"config": {"secret": "", "note": "n"}})
    assert stored(store)["ch1"]["config"]["secret"] == "x"
    assert v["config"] == {"app_id": "a", "note": "n"}

    v = m.update("ch1", {"clear_secrets": ["secret"]})
    assert v["secrets_set"] == [] and "secret" not in stored(store)["ch1"]["config"]


def test_create_rejects_bad_or_duplicate_ids(tmp_path):
    m, _, _, _, _, _ = make(tmp_path)
    m.create({"provider": "demo", "id": "dup"})
    for body in ({"provider": "demo", "id": "dup"}, {"provider": "demo", "id": "-x"},
                 {"provider": "nope"}):
        with pytest.raises(ValueError):
            m.create(body)
    assert m.create({"provider": "demo"})["id"].startswith("demo-")


def test_start_missing_required_records_error(tmp_path):
    m, hub, _, built, _, _ = make(tmp_path)
    m.create({"provider": "demo", "id": "c", "config": {"app_id": "a"}})
    with pytest.raises(ValueError, match="secret"):
        m.start("c")
    v = m.snapshot()["channels"][0]
    assert v["state"] == "error" and "missing required" in v["error"]
    assert not built and not hub.adapters
    assert any("start failed" in e["text"] for e in m.get_logs("c"))


def test_start_stop_persist_enabled_and_resolve_env(tmp_path, monkeypatch):
    monkeypatch.setenv("GAH_TEST_SECRET", "from-env")
    m, hub, store, built, _, _ = make(tmp_path)
    m.create({"provider": "demo", "id": "c",
              "config": {"app_id": "a", "secret": "env:GAH_TEST_SECRET"}})
    assert m.start("c")["state"] == "running"
    assert built == [("c", {"app_id": "a", "secret": "from-env"})]
    assert stored(store)["c"]["enabled"] is True and "c" in hub.adapters
    m.start("c")  # already running: no second adapter
    assert len(built) == 1

    assert m.stop("c")["state"] == "stopped"
    assert stored(store)["c"]["enabled"] is False and hub.disposed == ["c"]


def test_update_config_restarts_running_channel(tmp_path):
    m, hub, _, built, _, _ = make(tmp_path)
    m.create({"provider": "demo", "id": "c", "config": {"app_id": "a", "secret": "s"}})
    m.start("c")
    m.update("c", {"name": "Renamed"})  # name only: no restart
    assert len(built) == 1
    v = m.update("c", {"config": {"app_id": "b"}})
    assert v["state"] == "running" and v["name"] == "Renamed"
    assert [b[1]["app_id"] for b in built] == ["a", "b"] and hub.disposed == ["c"]


def test_provider_registration_autostarts_and_dispose_halts(tmp_path):
    m, hub, store, _, _, _ = make(tmp_path, register=False)
    store.save([{"id": "on", "provider": "demo", "enabled": True,
                 "config": {"app_id": "a", "secret": "s"}},
                {"id": "off", "provider": "demo", "enabled": False, "config": {}}])
    m2 = ChannelManager(hub, store)
    dispose = m2.register_provider(Provider("demo", lambda cid, cfg, log: cid, fields=FIELDS))
    states = {c["id"]: c["state"] for c in m2.snapshot()["channels"]}
    assert states == {"on": "running", "off": "stopped"}
    with pytest.raises(ValueError):
        m2.register_provider(Provider("demo", lambda *a: None))
    dispose()
    snap = m2.snapshot()
    assert snap["providers"] == [] and all(not c["available"] for c in snap["channels"])
    assert hub.disposed == ["on"] and stored(store)["on"]["enabled"] is True


def test_fail_marks_running_channel_error(tmp_path):
    m, _, _, _, _, _ = make(tmp_path)
    m.create({"provider": "demo", "id": "c", "config": {"app_id": "a", "secret": "s"}})
    m.fail("c", "ignored while stopped")
    assert m.snapshot()["channels"][0]["state"] == "stopped"
    m.start("c")
    m.fail("c", "socket closed")
    v = m.snapshot()["channels"][0]
    assert v["state"] == "error" and v["error"] == "socket closed"


def test_delete_halts_and_removes(tmp_path):
    m, hub, store, _, _, _ = make(tmp_path)
    m.create({"provider": "demo", "id": "c", "config": {"app_id": "a", "secret": "s"}})
    m.start("c")
    m.delete("c")
    assert hub.disposed == ["c"] and stored(store) == {}
    with pytest.raises(KeyError):
        m.delete("c")


def _wait(m, pid, done=("done", "error", "cancelled")):
    deadline = time.time() + 5
    while time.time() < deadline:
        v = m.pair_poll(pid)
        if v["status"] in done:
            return v
        time.sleep(0.01)
    raise AssertionError(f"pairing stuck: {v}")


def test_pairing_creates_and_starts_channel(tmp_path):
    def pair(update, cancelled):
        update(status="waiting", qr="qr-data")
        return {"app_id": "a", "secret": "s"}

    m, hub, store, _, _, _ = make(tmp_path, pair=pair)
    assert m.snapshot()["providers"][0]["pairable"] is True
    v = _wait(m, m.pair_begin({"provider": "demo", "id": "paired"})["id"])
    assert v["status"] == "done" and v["result"] == "paired" and v["qr"] == ""
    deadline = time.time() + 5
    while "paired" not in hub.adapters and time.time() < deadline:
        time.sleep(0.01)
    assert "paired" in hub.adapters and stored(store)["paired"]["config"]["secret"] == "s"


def test_pairing_cancel_and_errors(tmp_path):
    started = []

    def pair(update, cancelled):
        started.append(1)
        while not cancelled():
            time.sleep(0.01)
        return {"app_id": "a", "secret": "s"}

    m, _, store, _, _, _ = make(tmp_path, pair=pair)
    pid = m.pair_begin({"provider": "demo"})["id"]
    assert m.pair_cancel(pid)["status"] == "cancelled"
    time.sleep(0.1)
    assert m.pair_poll(pid)["status"] == "cancelled" and not store.path.exists()

    def boom(update, cancelled):
        raise RuntimeError("expired")
    m2, _, _, _, _, _ = make(tmp_path / "b", pair=boom)
    v = _wait(m2, m2.pair_begin({"provider": "demo"})["id"])
    assert v["status"] == "error" and v["error"] == "expired"

    m3, _, _, _, _, _ = make(tmp_path / "c")
    with pytest.raises(ValueError, match="QR"):
        m3.pair_begin({"provider": "demo"})
    with pytest.raises(KeyError):
        m3.pair_poll("missing")
