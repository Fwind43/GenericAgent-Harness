"""CLI startup integration without importing GA or reading model credentials."""
import json
from types import SimpleNamespace

import pytest

from ga_harness import cli


def test_cli_applies_saved_preferences_before_mount(tmp_path, monkeypatch, capsys):
    path = tmp_path / "plugins.json"
    path.write_text(json.dumps({"version": 1, "profiles": {"ga-compat": {
        "ga-events": {"enabled": False, "config": {"max_data": 1234}}
    }}}), encoding="utf-8")
    original = path.read_bytes()
    monkeypatch.setenv("GAH_PLUGIN_CONFIG", str(path))
    monkeypatch.setenv("GAH_REEXEC", "1")
    monkeypatch.delenv("GAH_PLUGIN_PATH", raising=False)
    monkeypatch.delenv("GAH_PROFILE_PATH", raising=False)
    mounted = []

    def capture_mount(rt, tree, manifests):
        catalog = rt.ctx.get("plugin.catalog")
        assert catalog["tree"] == tree
        baseline = next(e for e in catalog["preferences"].baseline if e["name"] == "ga-events")
        assert not baseline["disabled"]
        mounted.append(tree)
        rt.ctx.provide("frontend", SimpleNamespace(main=lambda **kwargs: 0))

    monkeypatch.setattr(cli, "mount", capture_mount)
    for _ in range(2):
        assert cli.main(["run", "synthetic task", "--ui", "web"]) == 0
    assert len(mounted) == 2 and mounted[0] == mounted[1]
    event = next(e for e in mounted[0] if e["name"] == "ga-events")
    assert event["disabled"] and event["config"]["max_data"] == 1234
    assert next(e for e in mounted[0] if e["name"] == "plugin-manager")
    assert path.read_bytes() == original
    assert cli.main(["tree", "--ui", "web"]) == 0
    assert "- ga-events" in capsys.readouterr().out
    assert path.read_bytes() == original


@pytest.mark.parametrize("command", ["tree", "run"])
def test_cli_refuses_corrupt_preferences_without_mounting(tmp_path, monkeypatch, capsys, command):
    path = tmp_path / "plugins.json"
    path.write_text("SYNTHETIC-PRIVATE-INVALID-JSON", encoding="utf-8")
    monkeypatch.setenv("GAH_PLUGIN_CONFIG", str(path))
    monkeypatch.setenv("GAH_REEXEC", "1")
    monkeypatch.delenv("GAH_PLUGIN_PATH", raising=False)
    monkeypatch.delenv("GAH_PROFILE_PATH", raising=False)

    def unexpected_mount(*args):
        pytest.fail("corrupt preferences must not mount plugins")

    monkeypatch.setattr(cli, "mount", unexpected_mount)
    assert cli.main([command]) == 2
    err = capsys.readouterr().err
    assert "plugin settings could not be loaded" in err
    assert "PRIVATE" not in err
    assert path.read_text(encoding="utf-8") == "SYNTHETIC-PRIVATE-INVALID-JSON"
