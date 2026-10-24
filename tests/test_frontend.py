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
