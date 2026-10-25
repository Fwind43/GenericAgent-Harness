"""Provider layer for model configs. Synthetic credentials only."""
import json

import pytest

from ga_harness import llmconfig
from tests.test_models import make_models


def rev(store):
    return store.config()["revision"]


def psave(store, pid="acme", **values):
    values = {"name": "Acme", "protocol": "oai", "apibase": "https://acme.invalid/v1",
              "apikey": "test-secret-acme"} | values
    return store.change({"action": "provider_save", "id": pid, "values": values, "revision": rev(store)})


def msave(store, key, **values):
    return store.change({"action": "save", "key": key, "values": values, "revision": rev(store)})


def test_resolve_providers_merges_connection_and_hides_table():
    data = {"providers": {"p": {"name": "P", "protocol": "oai", "apibase": "https://p.invalid", "apikey": "k"}},
            "native_oai_config_a": {"provider": "p", "model": "m"},
            "native_oai_config_b": {"provider": "p", "model": "n", "apibase": "https://own.invalid"}}
    out = llmconfig.resolve_providers(data)
    assert "providers" not in out
    assert out["native_oai_config_a"] == {"apibase": "https://p.invalid", "apikey": "k", "model": "m"}
    assert out["native_oai_config_b"]["apibase"] == "https://own.invalid"
    with pytest.raises(llmconfig.ConfigError):
        llmconfig.resolve_providers({"native_oai_config_x": {"provider": "missing", "model": "m"}})


def test_empty_provider_is_saved_but_invisible_to_ga(tmp_path):
    store = make_models(tmp_path)
    before = [c.backend.name for c in store.agent.llmclients]
    cfg = psave(store)
    assert [c.backend.name for c in store.agent.llmclients] == before
    assert cfg["providers"] == [{"id": "acme", "values": {"name": "Acme", "protocol": "oai",
                                 "apibase": "https://acme.invalid/v1"}, "has_key": True,
                                 "url_hidden": False, "models": 0}]
    assert "test-secret" not in json.dumps(cfg)
    assert "providers" not in store.source.load()
    # round-trip through TOML keeps the provider
    assert llmconfig.read_file(store.source.file)["providers"]["acme"]["apikey"] == "test-secret-acme"


def test_model_under_provider_inherits_key_and_groups_catalog(tmp_path):
    store = make_models(tmp_path)
    psave(store)
    cfg = msave(store, "native_oai_config_two", provider="acme", model="acme-two", name="Two", context_win=16384)
    raw = llmconfig.read_file(store.source.file)["native_oai_config_two"]
    assert raw == {"provider": "acme", "model": "acme-two", "name": "Two", "context_win": 16384}
    loaded = store.source.load()["native_oai_config_two"]
    assert loaded["apikey"] == "test-secret-acme" and loaded["apibase"] == "https://acme.invalid/v1"
    entry = next(e for e in cfg["entries"] if e["key"] == "native_oai_config_two")
    assert entry["provider"] == "acme" and entry["has_key"] is False and "apibase" not in entry["values"]
    assert next(p for p in cfg["providers"] if p["id"] == "acme")["models"] == 1
    items = {i["name"]: i["provider"] for i in store.catalog()["items"]}
    assert items == {"One": "example.invalid", "Two": "Acme"}
    assert "test-secret" not in json.dumps(cfg) + json.dumps(store.catalog())


def test_legacy_entry_moves_into_provider_on_edit(tmp_path):
    store = make_models(tmp_path)
    psave(store)
    msave(store, "native_oai_config_one", provider="acme")
    raw = llmconfig.read_file(store.source.file)["native_oai_config_one"]
    assert raw["provider"] == "acme" and "apikey" not in raw and "apibase" not in raw
    assert raw["temperature"] == 0.3  # unrelated fields preserved
    assert store.source.load()["native_oai_config_one"]["apikey"] == "test-secret-acme"


def test_provider_key_change_applies_to_all_models_and_empty_keeps_secret(tmp_path):
    store = make_models(tmp_path)
    psave(store)
    msave(store, "native_oai_config_two", provider="acme", model="acme-two")
    psave(store, apikey="", name="Renamed")
    assert llmconfig.read_file(store.source.file)["providers"]["acme"]["apikey"] == "test-secret-acme"
    psave(store, apikey="test-secret-new")
    assert store.source.load()["native_oai_config_two"]["apikey"] == "test-secret-new"


def test_mixed_protocols_share_provider_without_changing_models(tmp_path):
    store = make_models(tmp_path)
    psave(store)
    msave(store, "native_oai_config_two", provider="acme", model="acme-two")
    msave(store, "native_claude_config_three", provider="acme", model="acme-three")
    before = store.source.load()
    psave(store, protocol="claude", apikey="")
    assert store.source.load() == before
    entries = {e["key"]: e for e in store.config()["entries"]}
    assert entries["native_oai_config_two"]["protocol"] == "oai"
    assert entries["native_claude_config_three"]["protocol"] == "claude"
    rows = {e["model"]: e for e in store.catalog()["items"]}
    assert rows["acme-two"]["provider_id"] == rows["acme-three"]["provider_id"] == "provider:acme"
    assert rows["acme-three"]["provider"] == "Acme"


def test_catalog_groups_legacy_by_url_and_key_and_keeps_explicit_ids(tmp_path):
    store = make_models(tmp_path)
    msave(store, "native_claude_config_same", model="same", apibase="https://example.invalid/v1",
          apikey="test-secret-one")
    msave(store, "native_oai_config_other", model="other", apibase="https://example.invalid/v1",
          apikey="test-secret-other")
    psave(store, "a", name="Same display name")
    psave(store, "b", name="Same display name")
    msave(store, "native_oai_config_a", model="explicit-a", provider="a")
    msave(store, "native_oai_config_b", model="explicit-b", provider="b")
    catalog = store.catalog()
    rows = {e["model"]: e for e in catalog["items"]}
    assert rows["same"]["provider_id"] == rows["test-one"]["provider_id"]
    assert rows["other"]["provider_id"] != rows["test-one"]["provider_id"]
    assert rows["explicit-a"]["provider_id"] != rows["explicit-b"]["provider_id"]
    assert rows["explicit-a"]["provider"] == rows["explicit-b"]["provider"]
    assert "test-secret" not in json.dumps(catalog)
    assert store.catalog() == catalog


def test_provider_rules(tmp_path):
    store = make_models(tmp_path)
    psave(store)
    msave(store, "native_oai_config_two", provider="acme", model="acme-two")
    original = store.source.file.read_bytes()
    for body in ({"action": "provider_delete", "id": "acme"},
                 {"action": "provider_save", "id": "Bad Id", "values": {}},
                 {"action": "provider_save", "id": "new", "values": {"apibase": "file:///x", "apikey": "k"}},
                 {"action": "provider_save", "id": "new", "values": {"apibase": "https://x.invalid"}},
                 {"action": "save", "key": "native_oai_config_x", "values": {"provider": "nope", "model": "c"}}):
        with pytest.raises(ValueError):
            store.change(body | {"revision": rev(store)})
        assert store.source.file.read_bytes() == original
    store.change({"action": "delete", "key": "native_oai_config_two", "revision": rev(store)})
    cfg = store.change({"action": "provider_delete", "id": "acme", "revision": rev(store)})
    assert cfg["providers"] == [] and "providers" not in llmconfig.read_file(store.source.file)
