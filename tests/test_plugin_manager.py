import json
from pathlib import Path

import pytest

from ga_harness.kernel import Plugin, Runtime
from ga_harness.kernel.loader import Manifest, discover, mount
from ga_harness.plugin_manager import PluginManager, PluginPreferences, run_safe

PLUGINS = Path(__file__).resolve().parents[1] / "ga_harness" / "plugins"


def entry(name, config=None):
    return {"name": name, "disabled": False, "config": config or {}}


def make_manager(tmp_path):
    ms = discover([PLUGINS])
    ms["demo"] = Manifest("demo", "main:apply", tmp_path, inject=["ga.hooks"],
        settings={"limit": {"type": "integer", "min": 1, "max": 100, "default": 10},
                  "mode": {"type": "choice", "default": "fast", "label": "Mode", "label_zh": "\u6a21\u5f0f",
                           "options": [{"value": "fast", "label": "Fast", "label_zh": "\u5feb\u901f"},
                                       {"value": "safe", "label": "Safe", "label_zh": "\u7a33\u59a5"}]},
                  "note": {"type": "string", "multiline": True, "default": ""},
                  "secret": {"type": "string", "secret": True, "default": "DO-NOT-EXPOSE"}})
    ms["needs-tools"] = Manifest("needs-tools", "main:apply", tmp_path, inject=["ga.tools"])
    tree = [entry(n) for n in ["plugin-manager", "model-store", "ga-hooks", "ga-core", "ui-web"]]
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
        assert item(c)["config"] == {"limit": 10, "mode": "fast", "note": ""}
        assert item(c, "ga-core")["protected"]
        assert item(c, "ui-web")["protected"]
        assert item(c, "needs-tools")["missing"] == ["ga.tools"]
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


@pytest.mark.parametrize("name", ["plugin-manager", "ga-core", "ui-web", "ui-cli"])
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
        with pytest.raises(RuntimeError, match="needs-tools: missing ga.tools"):
            change(m, "needs-tools")
        old = m.catalog()["revision"]
        change(m, config={"limit": 11})
        raw = m.preferences.path.read_bytes()
        with pytest.raises(RuntimeError, match="reload"):
            change(m, config={"limit": 12}, revision=old)
        assert m.preferences.path.read_bytes() == raw
        change(m, "demo", False)
        assert not item(change(m, "ga-hooks", False), "ga-hooks")["enabled"]
        change(m, "ga-tools")
        assert item(change(m, "needs-tools"), "needs-tools")["enabled"]
    finally:
        rt.dispose()


def test_enabled_worker_only_entry_does_not_block_saves(tmp_path):
    rt, m = make_manager(tmp_path)
    try:
        p = m.preferences
        p.manifests["purge-worker"] = Manifest("purge-worker", "main:apply", tmp_path,
                                               inject=["run.host"], worker_only=True)
        data, _ = p.read()
        data["profiles"].setdefault(p.profile, {})["purge-worker"] = {"enabled": True, "config": {}}
        p.write(data)
        assert p.issues(p.resolve(data)) == []
        assert item(change(m, config={"limit": 13}))["config"]["limit"] == 13
        host = Runtime()
        try:
            assert mount(host, [{"name": "purge-worker", "disabled": False, "config": {}}],
                         p.manifests) == []
            assert "purge-worker" not in host.handles
        finally:
            host.dispose()
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


def test_plugin_categories(tmp_path):
    bundled = discover([PLUGINS])
    cats = {n: x.category for n, x in bundled.items()}
    assert cats["ga-core"] == "core"
    assert {cats[n] for n in ("ga-hooks", "ga-tools", "ga-prompt", "ga-stdout")} == {"extension"}
    assert {cats[n] for n in ("ga-events", "ga-usage", "ga-timing")} == {"observe"}
    # web-lan / web-tailscale expose the web UI on the network: declared as services.
    network = {"web-lan", "web-tailscale"}
    assert {cats[n] for n in network} == {"service"}
    assert all(c == "ui" for n, c in cats.items() if n.startswith(("ui-", "web-")) and n not in network)
    assert all(c == "service" for n, c in cats.items() if n.endswith("-store") or n == "plugin-manager")
    assert "other" not in cats.values()
    d = tmp_path / "third"
    for name, extra in (("no-cat", ""), ("bad-cat", 'category = "bogus"\n')):
        (d / name).mkdir(parents=True)
        (d / name / "plugin.toml").write_text(f'name = "{name}"\n{extra}', encoding="utf-8")
    found = discover([d])
    assert found["no-cat"].category == found["bad-cat"].category == "other"
    rt, m = make_manager(tmp_path)
    try:
        assert item(m.catalog(), "ga-core")["category"] == "core"
        assert item(m.catalog())["category"] == "other"
    finally:
        rt.dispose()


def test_choice_field_options_and_validation():
    from ga_harness.plugin_manager import public_fields, validate_values
    m = Manifest("c", "main:apply", Path("."), settings={
        "mode": {"type": "choice", "default": "a",
                 "options": ["a", {"value": "b", "label": "Bee", "label_zh": "\u871c\u8702"}]},
        "bad": {"type": "choice", "options": ["x", "x"]},
        "none": {"type": "choice"}})
    fields = public_fields(m)
    assert set(fields) == {"mode"}
    assert fields["mode"]["options"] == [{"value": "a", "label": "a", "label_zh": ""},
                                         {"value": "b", "label": "Bee", "label_zh": "\u871c\u8702"}]
    assert validate_values(m, {"mode": "b"}) == {"mode": "b"}
    for bad in [{"mode": "c"}, {"mode": 1}, {"bad": "x"}]:
        with pytest.raises(ValueError):
            validate_values(m, bad)


def test_bundled_plugin_settings_are_editable():
    from ga_harness.plugin_manager import public_fields
    ms = discover([PLUGINS])
    expect = {"ga-timing": {"print"},
              "ga-stdout": {"passthrough", "file"}, "ga-prompt": {"prepend", "append", "replace_file"},
              "ga-events": {"max_data", "max_prompt"}}
    for name, keys in expect.items():
        fields = public_fields(ms[name])
        assert set(fields) == keys, name
        for spec in fields.values():
            assert spec.get("label_zh") and "default" in spec, name

def test_agent_list_exposes_service_wiring(tmp_path):
    rt, m = make_manager(tmp_path)
    try:
        items = {i["name"]: i for i in m.agent_control({"action": "list"})["items"]}
        assert items["needs-tools"]["requires"] == ["ga.tools"]
        assert items["needs-tools"]["missing"] == ["ga.tools"]
        assert "ga.hooks" in items["ga-hooks"]["provides"]
        assert items["demo"]["missing"] == []
    finally:
        rt.dispose()

def test_run_safe_plugins(tmp_path):
    # Plugins that may be hot-applied while a task runs: hot, provide nothing,
    # need only the web host. Anything touching agent/runs/sessions stays locked.
    ms = discover([PLUGINS])
    safe = {n for n, m in ms.items() if run_safe(m, ms)}
    assert {"web-tailscale", "web-lan", "web-theme", "web-trace", "web-usage"} <= safe
    assert not safe & {"ga-core", "ga-hooks", "ga-events", "ga-steer", "ga-tools", "channels", "run-queue",
                       "conductor", "worldline", "web-workspaces", "web-channels", "ui-web", "plugin-manager"}
    rt, m = make_manager(tmp_path)
    try:
        assert m.run_safe("web-tailscale") and not m.run_safe("demo")
        assert not m.run_safe("missing") and not m.run_safe(None)
        assert item(m.catalog(), "web-tailscale")["run_safe"] is True
        assert item(m.catalog(), "demo")["run_safe"] is False
    finally:
        rt.dispose()


def test_import_replace_hot_reloads_enabled_user_plugin(tmp_path, monkeypatch):
    import io, sys, zipfile
    from ga_harness.plugin_manager import user_plugin_dir
    monkeypatch.setenv("GAH_HOME", str(tmp_path / "home"))
    def make_zip(version, marker):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("plugin.toml", f'name = "hot-user"\nversion = "{version}"\nentry = "main:apply"\nrequires = ["ga.hooks"]\n')
            zf.writestr("main.py", f'MARKER = "{marker}"\ndef apply(ctx, config):\n    return lambda: None\n')
        return buf.getvalue()
    rt, m = make_manager(tmp_path)
    m.preferences.plugin_dirs = [PLUGINS, user_plugin_dir()]
    try:
        r1 = m.import_plugin(make_zip("0.1.0", "v1"), filename="hot-0.1.0.zip")
        assert r1["imported"]["version"] == "0.1.0" and r1["imported"]["replaced"] is False
        assert item(r1, "hot-user")["version"] == "0.1.0"
        assert item(r1, "hot-user")["source_meta"]["version"] == "0.1.0"
        c1 = change(m, "hot-user", True)
        assert item(c1, "hot-user")["state"] == "active" and "hot-user" in rt.handles
        assert sys.modules["ga_harness_ext_hot_user.main"].MARKER == "v1"
        r2 = m.import_plugin(make_zip("0.2.0", "v2"), filename="hot-0.2.0.zip", replace=True)
        assert r2["imported"]["replaced"] is True
        assert r2["imported"]["hot_reloaded"] is True
        assert r2["imported"]["restart_required"] is False
        assert item(r2, "hot-user")["version"] == "0.2.0"
        assert item(r2, "hot-user")["state"] == "active"
        assert sys.modules["ga_harness_ext_hot_user.main"].MARKER == "v2"
    finally:
        rt.dispose()
