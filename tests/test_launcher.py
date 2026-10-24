import sys
from pathlib import Path

from ga_harness import launcher


def _fake_ga(tmp_path):
    root = tmp_path / "GA"
    py = root / (".venv/Scripts/python.exe" if sys.platform == "win32" else ".venv/bin/python")
    py.parent.mkdir(parents=True)
    py.write_text("")
    return root, py


def test_resolve_order(tmp_path, monkeypatch):
    monkeypatch.setenv("GAH_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("GA_ROOT", raising=False)
    assert launcher.resolve_ga_root() is None
    (tmp_path / "home").mkdir()
    (tmp_path / "home/config.toml").write_text('ga_root = "%s"\n' % (tmp_path / "cfg").as_posix())
    assert launcher.resolve_ga_root() == str((tmp_path / "cfg").resolve())
    monkeypatch.setenv("GA_ROOT", str(tmp_path / "env"))
    assert launcher.resolve_ga_root() == str((tmp_path / "env").resolve())
    assert launcher.resolve_ga_root(str(tmp_path / "cli")) == str((tmp_path / "cli").resolve())


def test_reexec_plan(tmp_path, monkeypatch):
    monkeypatch.delenv("GAH_REEXEC", raising=False)
    root, py = _fake_ga(tmp_path)
    assert launcher.reexec_command(["run", "x"], None) is None
    assert launcher.reexec_command(["run", "x"], str(tmp_path / "nope")) is None
    cmd, env = launcher.reexec_command(["run", "x"], str(root))
    assert cmd[0] == str(py) and cmd[1:] == ["-m", "ga_harness.cli", "run", "x"]
    assert env["GAH_REEXEC"] == "1" and env["GA_ROOT"] == str(root)
    assert env["PYTHONPATH"].split(";" if sys.platform == "win32" else ":")[0] == str(launcher.REPO)
    monkeypatch.setenv("GAH_REEXEC", "1")          # loop guard
    assert launcher.reexec_command(["run", "x"], str(root)) is None


def test_no_reexec_when_already_ga_python(tmp_path, monkeypatch):
    monkeypatch.delenv("GAH_REEXEC", raising=False)
    root, py = _fake_ga(tmp_path)
    monkeypatch.setattr(sys, "executable", str(py))
    assert launcher.reexec_command(["run", "x"], str(root)) is None
