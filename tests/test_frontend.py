import io
from pathlib import Path

import pytest

from ga_harness.cli import select_frontend
from ga_harness.kernel import Runtime
from ga_harness.kernel.loader import discover, mount

PLUGINS = Path(__file__).resolve().parents[1] / "ga_harness" / "plugins"


def _e(name, disabled=False):
    return {"name": name, "config": {}, "disabled": disabled}


def test_select_frontend_defaults_and_override():
    ms = discover([PLUGINS])
    assert [e["name"] for e in select_frontend([_e("ga-core")], ms, None)] == ["ga-core", "ui-cli"]
    t = select_frontend([_e("ga-core"), _e("ui-cli")], ms, None)
    assert [e["name"] for e in t] == ["ga-core", "ui-cli"]
    with pytest.raises(SystemExit):
        select_frontend([_e("ga-core")], ms, "nope")


class FakeAgent:
    def __init__(self, ctx):
        self.ctx = ctx
        self.calls = []

    def run(self, task, timeout=None):
        self.calls.append(task)
        self.ctx.emit("agent.chunk", "hel")
        self.ctx.emit("agent.chunk", "lo")


def test_ui_cli_streams_chunks(tmp_path):
    (tmp_path / "fake-agent").mkdir()
    (tmp_path / "fake-agent" / "plugin.toml").write_text(
        'name = "fake-agent"\nentry = "main:apply"\nprovides = ["agent"]\n')
    (tmp_path / "fake-agent" / "main.py").write_text(
        "import sys\n"
        "def apply(ctx, config):\n"
        "    ctx.provide('agent', sys.modules['tests_frontend_fake'](ctx))\n")
    import sys
    sys.modules["tests_frontend_fake"] = FakeAgent
    out = io.StringIO()
    ms = discover([PLUGINS, tmp_path])
    rt = Runtime()
    try:
        mount(rt, [_e("fake-agent"), {"name": "ui-cli", "config": {"stream": out}, "disabled": False}], ms)
        fe = rt.ctx.get("frontend")
        assert fe.main(task="hi") == 0
        assert out.getvalue() == "hello\n"
        assert fe.main(task=None) == 2
    finally:
        rt.dispose()
        sys.modules.pop("tests_frontend_fake", None)


class SlowAgent(FakeAgent):
    def __init__(self, ctx):
        super().__init__(ctx)
        import threading
        self.stop = threading.Event()
        self.aborts = 0

    def run(self, task, timeout=None):
        self.calls.append(task)
        if task == "slow":
            self.stop.wait(5)
            self.ctx.emit("agent.chunk", "stopped")
            return "x"
        self.ctx.emit("agent.chunk", "re:" + task)
        return "x"

    def abort(self):
        self.aborts += 1
        self.stop.set()


def _mount_with(tmp_path, cls, ui, cfg):
    import sys
    d = tmp_path / "fake-agent"
    d.mkdir(exist_ok=True)
    (d / "plugin.toml").write_text('name = "fake-agent"\nentry = "main:apply"\nprovides = ["agent"]\n')
    (d / "main.py").write_text(
        "import sys\n"
        "def apply(ctx, config):\n"
        "    ctx.provide('agent', sys.modules['tests_frontend_fake'](ctx))\n")
    sys.modules["tests_frontend_fake"] = cls
    rt = Runtime()
    mount(rt, [_e("fake-agent"), {"name": ui, "config": cfg, "disabled": False}], discover([PLUGINS, tmp_path]))
    return rt


def test_ui_tui_multi_turn_and_commands(tmp_path):
    lines = iter(["a", "", "/help", "b", "/exit", "never"])
    out = io.StringIO()
    rt = _mount_with(tmp_path, SlowAgent, "ui-tui", {"stream": out, "input": lambda p: next(lines)})
    try:
        fe = rt.ctx.get("frontend")
        assert fe.main(task="first") == 0
        agent = rt.ctx.get("agent")
        assert agent.calls == ["first", "a", "b"]
        s = out.getvalue()
        assert "re:first" in s and "re:b" in s and "commands:" in s
    finally:
        rt.dispose()


def test_ui_tui_eof_exits(tmp_path):
    def eof(p):
        raise EOFError
    rt = _mount_with(tmp_path, SlowAgent, "ui-tui", {"stream": io.StringIO(), "input": eof})
    try:
        assert rt.ctx.get("frontend").main() == 0
    finally:
        rt.dispose()


def test_ui_tui_ctrl_c_aborts_running_task(tmp_path, monkeypatch):
    import threading
    out = io.StringIO()
    rt = _mount_with(tmp_path, SlowAgent, "ui-tui", {"stream": out, "input": lambda p: "/exit"})
    try:
        fe = rt.ctx.get("frontend")
        real_join = threading.Thread.join
        fired = {"n": 0}

        def join(self, timeout=None):
            if self.name == "ui-tui-turn" and fired["n"] == 0:
                fired["n"] = 1
                raise KeyboardInterrupt
            return real_join(self, timeout)
        monkeypatch.setattr(threading.Thread, "join", join)
        assert fe.main(task="slow") == 0
        agent = rt.ctx.get("agent")
        assert agent.aborts == 1
        assert "[tui] aborted" in out.getvalue() and "stopped" in out.getvalue()
    finally:
        rt.dispose()
