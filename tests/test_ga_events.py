from pathlib import Path
from types import SimpleNamespace
import pytest

from ga_harness.kernel import Runtime
from ga_harness.kernel.loader import build_tree, discover, mount

ROOT = Path(__file__).resolve().parents[1]
GA_ROOT = Path(r"E:\Work\GenericAgent")
PLUGINS = ROOT / "ga_harness" / "plugins"
pytestmark = pytest.mark.skipif(not (GA_ROOT / "plugins" / "hooks.py").exists(), reason="GA not present")

NAMES = ("run.start", "turn.start", "assistant.text", "tool.call", "tool.result", "turn.end", "run.end")


def _mount():
    rt = Runtime()
    tree = [{"name": "ga-hooks", "disabled": False, "config": {"ga_root": str(GA_ROOT)}},
            {"name": "ga-events", "disabled": False, "config": {"max_data": 10}}]
    mount(rt, tree, discover([PLUGINS]))
    seen = []
    for n in NAMES:
        rt.ctx.events.on(n, lambda p, n=n: seen.append((n, p)))
    return rt, rt.ctx.get("ga.hooks"), seen


def test_profile_has_events_after_hooks():
    names = [e["name"] for e in build_tree("ga-compat", [ROOT / "ga_harness" / "profiles"], [])]
    assert names.index("ga-events") == names.index("ga-hooks") + 1


def test_full_turn_sequence():
    rt, hooks, seen = _mount()
    handler = SimpleNamespace(current_turn=1)
    resp = SimpleNamespace(content="<summary>run it</summary>ok", thinking="", tool_calls=[1])
    a = {"code": "print(1)", "_index": 0, "_tool_num": 2}
    hooks.trigger("agent_before", {})
    hooks.trigger("turn_before", {"turn": 1})
    hooks.trigger("llm_after", {"turn": 1, "response": resp})
    hooks.trigger("tool_before", {"self": handler, "tool_name": "code_run", "args": a})
    hooks.trigger("tool_after", {"self": handler, "tool_name": "code_run", "args": a,
                                 "ret": SimpleNamespace(data={"status": "error", "msg": "x" * 50})})
    hooks.trigger("tool_before", {"self": handler, "tool_name": "no_tool", "args": {}})
    hooks.trigger("turn_after", {"turn": 1, "exit_reason": {}})
    hooks.trigger("agent_after", {"exit_reason": {"result": "CURRENT_TASK_DONE"}})
    assert [n for n, _ in seen] == list(NAMES)
    d = dict(seen)
    assert d["assistant.text"]["summary"] == "run it"
    assert d["tool.call"] == {"id": "1.0", "turn": 1, "index": 0, "name": "code_run", "args": {"code": "print(1)"}}
    r = d["tool.result"]
    assert r["id"] == "1.0" and r["ok"] is False and "truncated" in r["data"] and r["seconds"] >= 0
    assert d["run.end"]["exit"]["result"] == "CURRENT_TASK_DONE"
    rt.remove("ga-events")
    seen.clear()
    hooks.trigger("turn_before", {"turn": 2})
    assert seen == []
    rt.remove("ga-hooks")
