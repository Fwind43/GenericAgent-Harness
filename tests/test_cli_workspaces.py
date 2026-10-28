"""Explicit startup scope must never silently fall back to another workspace."""
from types import SimpleNamespace

import pytest

from ga_harness import cli, launcher


@pytest.mark.parametrize("option,value", [("--workspace", "DIR"), ("--project", "project-a")])
@pytest.mark.parametrize("active", [False, True])
def test_startup_scope_config_and_fail_closed(tmp_path, monkeypatch, capfd, option, value, active):
    monkeypatch.setenv("GAH_PLUGIN_CONFIG", str(tmp_path / "plugins.json"))
    monkeypatch.delenv("GAH_PLUGIN_PATH", raising=False)
    monkeypatch.delenv("GAH_PROFILE_PATH", raising=False)
    monkeypatch.setattr(launcher, "resolve_ga_root", lambda _: str(tmp_path))
    monkeypatch.setattr(launcher, "maybe_reexec", lambda *_: None)
    mounted, called = [], []
    value = str(tmp_path) if value == "DIR" else value

    def mount(rt, tree, manifests):
        mounted.append(next(e for e in tree if e["name"] == "workspace-store"))
        rt.ctx.provide("frontend", SimpleNamespace(main=lambda **kw: called.append(kw) or 0))
        if active:
            rt.ctx.provide("workspaces", object())

    monkeypatch.setattr(cli, "mount", mount)
    assert cli.main(["run", "hello", option, value]) == (0 if active else 2)
    config = mounted[0]["config"]
    assert config["start_workspace" if option == "--workspace" else "start_project"] == value
    assert len(called) == int(active)
    if not active:
        assert "refusing to run" in capfd.readouterr().err


def test_startup_scope_arguments_are_exclusive():
    with pytest.raises(SystemExit) as error:
        cli.main(["run", "--workspace", "/tmp", "--project", "p"])
    assert error.value.code == 2
