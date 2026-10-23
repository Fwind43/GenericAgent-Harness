from pathlib import Path
import pytest

from ga_harness.kernel import Runtime
from ga_harness.kernel.loader import discover, mount

GA_ROOT = Path(r"E:\Work\GenericAgent")
PLUGINS = Path(__file__).resolve().parents[1] / "ga_harness" / "plugins"
pytestmark = pytest.mark.skipif(not (GA_ROOT / "plugins" / "hooks.py").exists(), reason="GA not present")


def test_bridge_roundtrip_and_unload():
    rt = Runtime()
    mount(rt, [{"name": "ga-hooks", "disabled": False, "config": {"ga_root": str(GA_ROOT)}}], discover([PLUGINS]))
    assert rt.handles["ga-hooks"].state == "active"
    hooks = rt.ctx.get("ga.hooks")
    seen = []

    def mw(gactx, nxt):
        seen.append(gactx["tool_name"])
        return nxt({**gactx, "patched": True})
    off = rt.ctx.events.on("ga.tool_before", mw)
    out = hooks.trigger("tool_before", {"tool_name": "code_run"})
    assert seen == ["code_run"] and out["patched"] is True
    off()
    # no listener -> GA ctx unchanged identity
    d = {"tool_name": "x"}
    assert hooks.trigger("tool_before", d) is d
    rt.remove("ga-hooks")
    assert not hooks.has("tool_before")
    assert rt.ctx.get("ga.hooks") is None
