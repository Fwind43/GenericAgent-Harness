from pathlib import Path
import time
import pytest

from ga_harness.kernel import Runtime
from ga_harness.kernel.loader import build_tree, discover, mount

ROOT = Path(__file__).resolve().parents[1]
GA_ROOT = Path(r"E:\Work\GenericAgent")
PLUGINS = ROOT / "ga_harness" / "plugins"
pytestmark = pytest.mark.skipif(not (GA_ROOT / "plugins" / "hooks.py").exists(), reason="GA not present")


def test_patch_inserts_after_hooks():
    tree = build_tree("ga-compat", [ROOT / "ga_harness" / "profiles"], [ROOT / "examples" / "patches" / "tool-timer.toml"])
    names = [e["name"] for e in tree]
    assert names.index("tool-timer") == names.index("ga-hooks") + 1


def test_times_paired_calls_and_unloads():
    rt = Runtime()
    tree = [{"name": "ga-hooks", "disabled": False, "config": {"ga_root": str(GA_ROOT)}},
            {"name": "tool-timer", "disabled": False, "config": {"print": False}}]
    mount(rt, tree, discover([PLUGINS]))
    hooks, timer = rt.ctx.get("ga.hooks"), rt.ctx.get("tool.timer")
    seen = []
    rt.ctx.events.on("tool.timed", seen.append)
    a1, a2 = {"_index": 0}, {"_index": 1}
    hooks.trigger("tool_before", {"tool_name": "code_run", "args": a1})
    hooks.trigger("tool_before", {"tool_name": "file_read", "args": a2})
    time.sleep(0.02)
    hooks.trigger("tool_after", {"tool_name": "file_read", "args": a2, "ret": 1})
    hooks.trigger("tool_after", {"tool_name": "code_run", "args": a1, "ret": 1})
    assert [r["tool"] for r in seen] == ["file_read", "code_run"]
    assert all(r["seconds"] >= 0.015 for r in seen) and seen[0]["index"] == 1
    st = timer.stats()
    assert st["code_run"]["count"] == 1 and st["file_read"]["count"] == 1
    # unmatched after is ignored
    hooks.trigger("tool_after", {"tool_name": "x", "args": {}})
    assert len(timer.calls) == 2
    n = {}
    hooks.trigger("tool_before", {"tool_name": "no_tool", "args": n})
    hooks.trigger("tool_after", {"tool_name": "no_tool", "args": n})
    assert len(timer.calls) == 2
    rt.dispose()
    assert not hooks.has("tool_before")
