import sys
import types
from pathlib import Path
import pytest

from ga_harness.kernel import Runtime
from ga_harness.kernel.loader import build_tree, discover, mount

ROOT = Path(__file__).resolve().parents[1]
GA_ROOT = Path(r"E:\Work\GenericAgent")
PLUGINS = ROOT / "ga_harness" / "plugins"
pytestmark = pytest.mark.skipif(not (GA_ROOT / "plugins" / "hooks.py").exists(), reason="GA not present")


@pytest.fixture
def fake_llmcore(monkeypatch):
    mod = types.ModuleType("llmcore")
    mod.STATS = {}
    mod.printed = []

    def _record_usage(usage, api_mode):
        mod.printed.append(api_mode)
        mod.STATS.update(out=0)

    mod._record_usage = _record_usage
    monkeypatch.setitem(sys.modules, "llmcore", mod)
    return mod


def _mount():
    rt = Runtime()
    tree = [{"name": "ga-hooks", "disabled": False, "config": {"ga_root": str(GA_ROOT)}},
            {"name": "ga-usage", "disabled": False, "config": {}}]
    mount(rt, tree, discover([PLUGINS]))
    seen = []
    for n in ("usage", "usage.total"):
        rt.ctx.events.on(n, lambda p, n=n: seen.append((n, p)))
    return rt, rt.ctx.get("ga.hooks"), seen


def _call(hooks, mod, turn, usage, mode, late_out=None):
    hooks.trigger("llm_before", {"turn": turn})
    mod._record_usage(usage, mode)          # GA calls it by global name inside llmcore
    if late_out is not None:
        mod.STATS["out"] = late_out          # messages stream: output counted at message_delta
    hooks.trigger("llm_after", {"turn": turn})


def test_profile_includes_usage():
    names = [e["name"] for e in build_tree("ga-compat", [ROOT / "ga_harness" / "profiles"], [])]
    assert names.index("ga-usage") > names.index("ga-hooks")


def test_per_call_and_total(fake_llmcore):
    rt, hooks, seen = _mount()
    m = fake_llmcore
    hooks.trigger("agent_before", {})
    _call(hooks, m, 1, {"input_tokens": 10, "cache_creation_input_tokens": 100,
                        "cache_read_input_tokens": 1000, "output_tokens": 1}, "messages", late_out=42)
    _call(hooks, m, 2, {"prompt_tokens": 500, "completion_tokens": 7,
                        "prompt_tokens_details": {"cached_tokens": 300}}, "chat_completions")
    _call(hooks, m, 3, {"input_tokens": 50, "output_tokens": 5,
                        "input_tokens_details": None}, "responses")
    hooks.trigger("llm_before", {"turn": 4})   # call without usage -> no event
    hooks.trigger("llm_after", {"turn": 4})
    hooks.trigger("agent_after", {"exit_reason": {}})
    assert m.printed == ["messages", "chat_completions", "responses"]   # GA still runs
    calls = [p for n, p in seen if n == "usage"]
    assert calls == [
        {"turn": 1, "input": 1110, "cache_read": 1000, "cache_write": 100, "output": 42},
        {"turn": 2, "input": 500, "cache_read": 300, "cache_write": 0, "output": 7},
        {"turn": 3, "input": 50, "cache_read": 0, "cache_write": 0, "output": 5},
    ]
    assert seen[-1] == ("usage.total", {"calls": 3, "input": 1660, "cache_read": 1300,
                                        "cache_write": 100, "output": 54})
    seen.clear()
    hooks.trigger("agent_before", {})          # next run starts from zero
    _call(hooks, m, 1, {"prompt_tokens": 1, "completion_tokens": 1}, "chat_completions")
    hooks.trigger("agent_after", {})
    assert seen[-1][1]["calls"] == 1 and seen[-1][1]["input"] == 1
    rt.remove("ga-usage")
    rt.remove("ga-hooks")


def test_unmount_restores_record_usage(fake_llmcore):
    orig = fake_llmcore._record_usage
    rt, hooks, seen = _mount()
    hooks.trigger("llm_before", {"turn": 1})
    assert fake_llmcore._record_usage is not orig and fake_llmcore._record_usage.__wrapped__ is orig
    rt.remove("ga-usage")
    assert fake_llmcore._record_usage is orig
    hooks.trigger("agent_after", {})
    assert seen == []
    rt.remove("ga-hooks")


def test_bad_usage_never_breaks_ga(fake_llmcore):
    rt, hooks, seen = _mount()
    _call(hooks, fake_llmcore, 1, {"prompt_tokens": "x", "completion_tokens": None}, "chat_completions")
    _call(hooks, fake_llmcore, 2, None, "messages")
    assert [p for n, p in seen] == [{"turn": 1, "input": 0, "cache_read": 0, "cache_write": 0, "output": 0}]
    rt.remove("ga-usage")
    rt.remove("ga-hooks")
