import sys
import textwrap
import uuid
from pathlib import Path

from ga_harness.kernel import Runtime
from ga_harness.kernel.loader import discover, mount

PLUGINS = Path(__file__).resolve().parents[1] / "ga_harness" / "plugins"

FAKE = textwrap.dedent('''
    import queue
    TOOLS_SCHEMA = None
    LOADS = 0
    def load_tool_schema(suffix=""):
        global TOOLS_SCHEMA, LOADS
        LOADS += 1
        TOOLS_SCHEMA = [{"type": "function", "function": {"name": n}} for n in ("code_run", "web_scan")]
    load_tool_schema()
    def get_system_prompt():
        return "BASE"
    class GenericAgentHandler:
        def do_code_run(self, args, response): return "ran"
        def do_web_scan(self, args, response): return "scanned"
    class GenericAgent:
        def __init__(self):
            self.llmclients = ["fake"]; self.task_queue = queue.Queue()
        def abort(self): pass
        def run(self):
            while not isinstance(self.task_queue.get(), str): pass
''')
AGENT_LOOP = textwrap.dedent('''
    from dataclasses import dataclass
    @dataclass
    class StepOutcome:
        data: object
        next_prompt: str = None
        should_exit: bool = False
''')


def _mount(tmp_path, extra):
    mod = "fake_agentmain_" + uuid.uuid4().hex[:8]
    (tmp_path / f"{mod}.py").write_text(FAKE, encoding="utf-8")
    if "agent_loop" not in sys.modules:
        (tmp_path / "agent_loop.py").write_text(AGENT_LOOP, encoding="utf-8")
    rt = Runtime()
    tree = [{"name": "ga-core", "disabled": False, "config": {"ga_root": str(tmp_path), "module": mod}}]
    tree += [{"name": n, "disabled": False, "config": c} for n, c in extra]
    mount(rt, tree, discover([PLUGINS]))
    return rt, sys.modules[mod]


def test_tools_disable_register_and_restore(tmp_path):
    rt, m = _mount(tmp_path, [("ga-tools", {"disable": ["web_scan"]})])
    assert rt.handles["ga-tools"].state == "active"
    tools = rt.ctx.get("ga.tools")
    assert tools.names() == ["code_run"]
    out = m.GenericAgentHandler().do_web_scan({}, "")
    assert "disabled" in out.data and "disabled" in out.next_prompt

    d = tools.register({"type": "function", "function": {"name": "echo"}},
                       lambda self, args, response: "echo:" + args["x"])
    assert tools.names() == ["code_run", "echo"]
    assert m.GenericAgentHandler().do_echo({"x": "1"}, "") == "echo:1"
    m.load_tool_schema()  # GA rebuilds on LLM switch -> overlay survives
    assert tools.names() == ["code_run", "echo"]
    d()
    assert tools.names() == ["code_run"] and not hasattr(m.GenericAgentHandler, "do_echo")

    rt.dispose()
    assert [t["function"]["name"] for t in m.TOOLS_SCHEMA] == ["code_run", "web_scan"]
    assert m.GenericAgentHandler().do_web_scan({}, "") == "scanned"
    assert not hasattr(m.load_tool_schema, "__wrapped__")


def test_prompt_waterfall(tmp_path):
    rt, m = _mount(tmp_path, [("ga-prompt", {"prepend": "PRE", "append": "POST"})])
    assert m.get_system_prompt() == "PRE\nBASE\nPOST"
    off = rt.ctx.on("ga.system_prompt", lambda p, nxt: nxt(p) + "+plug")
    assert m.get_system_prompt() == "PRE\nBASE+plug\nPOST"
    off()
    rt.dispose()
    assert m.get_system_prompt() == "BASE"


def test_prompt_replace_file(tmp_path):
    f = tmp_path / "p.txt"
    f.write_text("MINE", encoding="utf-8")
    rt, m = _mount(tmp_path, [("ga-prompt", {"replace_file": str(f)})])
    assert m.get_system_prompt() == "MINE"
    rt.dispose()
