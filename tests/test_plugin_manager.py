import json
from pathlib import Path

import pytest

from ga_harness.kernel import Plugin, Runtime
from ga_harness.kernel.loader import Manifest, discover, mount
from ga_harness.plugin_manager import PluginManager, PluginPreferences

PLUGINS = Path(__file__).resolve().parents[1] / "ga_harness" / "plugins"


def entry(name, config=None):
    return {"name": name, "disabled": False, "config": config or {}}


def make_manager(tmp_path):
    ms = discover([PLUGINS])
    ms["demo"] = Manifest("demo", "main:apply", tmp_path, inject=["ga.hooks"],
        settings={"limit": {"type": "integer", "min": 1, "max": 100, "default": 10},
                  "secret": {"type": "string", "secret": True, "default": "DO-NOT-EXPOSE"}})
    tree = [entry(n) for n in ["plugin-manager", "llm-config", "ga-hooks", "ga-core", "ui-web"]]
    tree.insert(-1, entry("demo", {"limit": 10, "secret": "DO-NOT-EXPOSE"}))
    p = PluginPreferences(tmp_path / "plugins.json", "test", ms, tree)
    rt = Runtime()
    for name in ["ga-hooks", "ga-core"]:
        caps = ms[name].provides
        def apply(ctx, config, caps=caps):
            for cap in caps:
                ctx.provide(cap, object())
        rt.add(Plugin(name, apply))
    rt.ctx.provide("plugin.catalog", {"preferences": p, "tree": tree})
    mount(rt, [entry("plugin-manager")], ms)
    return rt, rt.ctx.get("plugin.manager")


def change(manager, name="demo", enabled=True, config=None, **extra):
    return manager.change({"name": name, "enabled": enabled, "config": config or {},
                           "revision": manager.catalog()["revision"], **extra})


def item(catalog, name="demo"):
    return next(x for x in catalog["items"] if x["name"] == name)


def test_catalog_is_safe_and_inspects_without_imports(tmp_path):
    rt, m = make_manager(tmp_path)
    try:
        c = m.catalog()
        assert "DO-NOT-EXPOSE" not in json.dumps(c)
        assert item(c)["config"] == {"limit": 10}
        assert item(c, "ga-core")["protected"]
        assert item(c, "ui-web")["protected"]
        assert item(c, "tool-grep")["missing"] == ["ga.tools"]
        assert "demo" in item(c, "ga-hooks")["dependents"]
        assert not c["restart_required"]
        assert item(c, "plugin-manager")["state"] == "active"
    finally:
        rt.dispose()


def test_persist_cold_reload_reset_and_idempotency(tmp_path):
    rt, m = make_manager(tmp_path)
    try:
        c = change(m, config={"limit": 25})
        assert item(c)["restart_required"]
        raw = m.preferences.path.read_bytes()
        change(m, config={"limit": 25})
        assert m.preferences.path.read_bytes() == raw
        resolved = m.preferences.resolve(m.preferences.read()[0])
        assert next(e for e in resolved if e["name"] == "demo")["config"] == {"limit": 25, "secret": "DO-NOT-EXPOSE"}
        new = PluginManager(rt.ctx, m.preferences, resolved)
        assert not new.catalog()["restart_required"]
        assert item(new.catalog())["config"]["limit"] == 25
        c = change(new, action="reset")
        assert item(c)["config"]["limit"] == 10
        assert item(c)["restart_required"]
    finally:
        rt.dispose()


@pytest.mark.parametrize("name", ["plugin-manager", "ga-core", "llm-config", "ui-web", "ui-cli"])
def test_protected(tmp_path, name):
    rt, m = make_manager(tmp_path)
    try:
        with pytest.raises(ValueError, match="protected"):
            change(m, name, False)
        assert not m.preferences.path.exists()
    finally:
        rt.dispose()


@pytest.mark.parametrize("config", [{"secret": "x"}, {"limit": True}, {"limit": 0}, {"limit": 101}, {"limit": "10"}])
def test_invalid_config_no_write(tmp_path, config):
    rt, m = make_manager(tmp_path)
    try:
        with pytest.raises(ValueError):
            change(m, config=config)
        assert not m.preferences.path.exists()
    finally:
        rt.dispose()


def test_dependencies_and_stale_revision_do_not_write(tmp_path):
    rt, m = make_manager(tmp_path)
    try:
        with pytest.raises(RuntimeError, match="demo: missing ga.hooks"):
            change(m, "ga-hooks", False)
        with pytest.raises(RuntimeError, match="tool-grep: missing ga.tools"):
            change(m, "tool-grep")
        old = m.catalog()["revision"]
        change(m, config={"limit": 11})
        raw = m.preferences.path.read_bytes()
        with pytest.raises(RuntimeError, match="reload"):
            change(m, config={"limit": 12}, revision=old)
        assert m.preferences.path.read_bytes() == raw
        change(m, "demo", False)
        assert not item(change(m, "ga-hooks", False), "ga-hooks")["enabled"]
        change(m, "ga-tools")
        c = change(m, "tool-grep", config={"max_results": 30})
        assert item(c, "tool-grep")["enabled"]
    finally:
        rt.dispose()


def test_corruption_and_write_failure_preserve_state(tmp_path, monkeypatch):
    rt, m = make_manager(tmp_path)
    try:
        change(m, config={"limit": 11})
        raw = m.preferences.path.read_bytes()
        def fail(*args):
            raise OSError("disk failure")
        monkeypatch.setattr("ga_harness.plugin_manager.os.replace", fail)
        with pytest.raises(OSError):
            change(m, config={"limit": 12})
        assert m.preferences.path.read_bytes() == raw
        assert not m.preferences.path.with_suffix(".json.lock").exists()
        m.preferences.path.write_text("{broken", encoding="utf-8")
        with pytest.raises(ValueError, match="invalid plugin settings"):
            m.catalog()
        assert m.preferences.path.read_text() == "{broken"
    finally:
        rt.dispose()


def test_profile_isolation_and_writer_lock(tmp_path):
    rt, m = make_manager(tmp_path)
    try:
        change(m, config={"limit": 11})
        other = PluginPreferences(m.preferences.path, "other", m.preferences.manifests, m.preferences.baseline)
        other_manager = PluginManager(rt.ctx, other, other.baseline)
        assert item(other_manager.catalog())["config"]["limit"] == 10
        change(other_manager, config={"limit": 12})
        assert item(m.catalog())["config"]["limit"] == 11
        lock = m.preferences.path.with_suffix(".json.lock")
        lock.write_text("another writer")
        with pytest.raises(RuntimeError, match="locked"):
            change(m)
        assert lock.read_text() == "another writer"
    finally:
        rt.dispose()


def test_bundled_plugins_ship_chinese_descriptions(tmp_path):
    rt, m = make_manager(tmp_path)
    try:
        bundled = discover([PLUGINS])
        assert bundled and all(x.description and x.description_zh for x in bundled.values())
        core = item(m.catalog(), "ga-core")
        assert core["description_zh"] == bundled["ga-core"].description_zh
        assert item(m.catalog())["description_zh"] == ""
    finally:
        rt.dispose()
