import io
import sys

from ga_harness.kernel import Runtime
from ga_harness.kernel.loader import discover, mount
from ga_harness.textview import TextView, arg_summary, result_lines

from test_frontend import PLUGINS, _e

RAW = "\n**LLM Running (Turn 1) ...**\n\n<summary>s</summary>\n\n\U0001f6e0\ufe0f Tool: `code_run`"


def emit_ga_run(ctx, final_turn_end=False):
    """Event order of a real GA run: run.start, turn.start before its chunks, no turn.end on the last turn."""
    ctx.emit("run.start", {})
    ctx.emit("turn.start", {"turn": 1})
    ctx.emit("agent.chunk", RAW)
    ctx.emit("assistant.text", {"turn": 1, "text": "<summary>run it</summary>", "reply": "", "summary": "run it"})
    ctx.emit("tool.call", {"id": "1.0", "turn": 1, "index": 0, "name": "code_run",
                           "args": {"cwd": "x", "script": "print(2**20)\nprint(1)", "type": "python"}})
    ctx.emit("agent.chunk", "[Stdout]\n1048576")
    ctx.emit("tool.result", {"id": "1.0", "turn": 1, "index": 0, "name": "code_run", "ok": True,
                             "data": '{"status": "success", "stdout": "1048576\\r\\n1\\r\\n", "exit_code": 0}',
                             "seconds": 1.04})
    ctx.emit("turn.end", {"turn": 1, "exit": {}})
    ctx.emit("turn.start", {"turn": 2})
    ctx.emit("agent.chunk", "**LLM Running (Turn 2) ...**")
    ctx.emit("assistant.text", {"turn": 2, "text": "<summary>done</summary>\nresult: 1048576",
                                "reply": "result: 1048576", "summary": "done"})
    ctx.emit("run.end", {"exit": {"result": "EXITED"}})


def test_arg_and_result_helpers():
    assert arg_summary({"cwd": "x", "script": "a\n  b"}) == "a b"
    assert arg_summary({"n": 1}) == '{"n": 1}'
    assert arg_summary({}) == ""
    assert len(arg_summary({"script": "x" * 200}, 20)) == 20
    assert result_lines('{"status": "success", "stdout": "a\\nb\\n"}') == ["a", "b"]
    assert result_lines("l1\nl2\nl3\nl4", lines=2) == ["l1", "l2", "... (+2 lines)"]
    assert result_lines({"status": "error", "msg": "boom"}) == ["boom"]
    assert result_lines(None) == [] and result_lines("x", lines=0) == []


def test_textview_renders_events_and_drops_ga_display_text():
    rt = Runtime()
    out = []
    v = TextView(rt.ctx, out.append)
    off = v.attach()
    v.begin()
    emit_ga_run(rt.ctx)
    off()
    s = "".join(out)
    assert "LLM Running" not in s and "Tool:" not in s and "[Stdout]" not in s and "<summary>" not in s
    assert s == ("-- step 1: run it\n"
                 "  > code_run  print(2**20) print(1)\n"
                 "    ok 1.0s\n    | 1048576\n    | 1\n"
                 "-- step 2: done\nresult: 1048576\n")
    rt.ctx.emit("tool.call", {"name": "x"})          # detached: nothing more
    assert "".join(out) == s
    rt.dispose()


def test_textview_failed_tool_and_raw_modes():
    rt = Runtime()
    out = []
    off = TextView(rt.ctx, out.append).attach()
    rt.ctx.emit("tool.result", {"name": "file_read", "ok": False, "data": {"status": "error", "msg": "no such file"}})
    assert "".join(out) == "    FAILED\n    | no such file\n"
    off()
    out.clear()
    off = TextView(rt.ctx, out.append, raw=True).attach()   # debug: GA's own text, untouched
    emit_ga_run(rt.ctx)
    off()
    assert "".join(out) == RAW + "[Stdout]\n1048576**LLM Running (Turn 2) ...**"
    rt.dispose()


def test_textview_falls_back_to_chunks_without_ga_events():
    rt = Runtime()
    out = []
    v = TextView(rt.ctx, out.append)
    off = v.attach()
    v.begin()
    rt.ctx.emit("agent.chunk", "plain ")
    rt.ctx.emit("agent.chunk", "agent")
    assert "".join(out) == "plain agent"
    rt.ctx.emit("run.start", {})
    rt.ctx.emit("agent.chunk", "**LLM Running (Turn 1) ...**")
    assert "".join(out) == "plain agent"
    v.begin()                                         # next run decides again
    rt.ctx.emit("agent.chunk", "again")
    assert "".join(out) == "plain agentagain"
    off()
    rt.dispose()


class GaLikeAgent:
    def __init__(self, ctx):
        self.ctx = ctx

    def run(self, task, timeout=None):
        emit_ga_run(self.ctx)
        return "x"


def test_ui_cli_renders_structured_steps(tmp_path):
    from test_frontend import _mount_with
    out = io.StringIO()
    rt = _mount_with(tmp_path, GaLikeAgent, "ui-cli", {"stream": out})
    try:
        assert rt.ctx.get("frontend").main(task="t") == 0
        s = out.getvalue()
        assert s.startswith("-- step 1: run it\n  > code_run")
        assert "LLM Running" not in s and "-- step 2: done\nresult: 1048576\n" in s
    finally:
        rt.dispose()
        sys.modules.pop("tests_frontend_fake", None)


def test_ui_tui_renders_structured_steps(tmp_path):
    from test_frontend import _mount_with
    lines = iter(["/exit"])
    out = io.StringIO()
    rt = _mount_with(tmp_path, GaLikeAgent, "ui-tui", {"stream": out, "input": lambda p: next(lines)})
    try:
        assert rt.ctx.get("frontend").main(task="t") == 0
        s = out.getvalue()
        assert "-- step 1: run it" in s and "    | 1048576" in s and "LLM Running" not in s
    finally:
        rt.dispose()
        sys.modules.pop("tests_frontend_fake", None)
