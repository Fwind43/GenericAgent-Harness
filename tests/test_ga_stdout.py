import io
import sys
from pathlib import Path

from ga_harness.kernel import Runtime
from ga_harness.kernel.loader import discover, mount
from ga_harness.textview import TextView

PLUGINS = Path(__file__).resolve().parents[1] / "ga_harness" / "plugins"


def _mount(config=None):
    rt = Runtime()
    mount(rt, [{"name": "ga-stdout", "config": config or {}, "disabled": False}], discover([PLUGINS]))
    return rt


def test_captures_lines_and_restores():
    before_out, before_err = sys.stdout, sys.stderr
    rt = _mount()
    got = []
    try:
        rt.ctx.events.on("agent.log", lambda d: got.append(d))
        console = rt.ctx.get("console")
        assert console.out is before_out and console.err is before_err
        print("[Info] hello")
        print("a\nb", end="")          # partial last line waits for newline / flush
        assert got == [{"stream": "stdout", "text": "[Info] hello"}, {"stream": "stdout", "text": "a"}]
        print(" tail")
        sys.stderr.write("boom\n")
        assert got[2:] == [{"stream": "stdout", "text": "b tail"}, {"stream": "stderr", "text": "boom"}]
        print("unterminated", end="")
    finally:
        rt.dispose()
    assert sys.stdout is before_out and sys.stderr is before_err
    assert got[-1] == {"stream": "stdout", "text": "unterminated"}   # flushed on dispose


def test_listener_print_does_not_loop(capsys):
    rt = _mount()
    got = []
    try:
        def on(d):
            got.append(d["text"])
            print("from listener")          # would recurse without the busy guard
        rt.ctx.events.on("agent.log", on)
        print("x")
    finally:
        rt.dispose()
    assert got == ["x"]
    assert "from listener" in capsys.readouterr().out


def test_passthrough_and_file(tmp_path, capsys):
    log = tmp_path / "ga.log"
    rt = _mount({"passthrough": True, "file": str(log)})
    try:
        print("seen")
    finally:
        rt.dispose()
    assert "seen" in capsys.readouterr().out
    assert log.read_text(encoding="utf-8").rstrip().endswith("stdout seen")


def test_default_is_quiet(capsys):
    rt = _mount()
    try:
        print("hidden")
    finally:
        rt.dispose()
    assert "hidden" not in capsys.readouterr().out


def test_textview_show_log():
    rt = Runtime()
    out = io.StringIO()
    off = TextView(rt.ctx, out.write, show_log=True).attach()
    try:
        rt.ctx.emit("agent.log", {"stream": "stdout", "text": "[Info] x"})
        rt.ctx.emit("agent.log", {"stream": "stdout", "text": "   "})
    finally:
        off()
        rt.dispose()
    assert out.getvalue() == "  . [Info] x\n"
    out2 = io.StringIO()
    rt2 = Runtime()
    TextView(rt2.ctx, out2.write).attach()
    rt2.ctx.emit("agent.log", {"stream": "stdout", "text": "y"})
    rt2.dispose()
    assert out2.getvalue() == ""
