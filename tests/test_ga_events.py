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
    # after, not necessarily adjacent: other hook consumers (ga-timing) load in between
    assert names.index("ga-hooks") < names.index("ga-events")


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
    assert d["assistant.text"]["reply"] == "ok"
    assert d["tool.call"] == {"id": "1.0", "turn": 1, "index": 0, "name": "code_run", "args": {"code": "print(1)"}}
    r = d["tool.result"]
    assert r["id"] == "1.0" and r["ok"] is False and "truncated" in r["data"] and r["seconds"] >= 0
    assert d["run.end"]["exit"]["result"] == "CURRENT_TASK_DONE"
    rt.remove("ga-events")
    seen.clear()
    hooks.trigger("turn_before", {"turn": 2})
    assert seen == []
    rt.remove("ga-hooks")


@pytest.mark.parametrize("chunk_size", [1, 7, 10000])
@pytest.mark.parametrize("prefix, summary, thinking, reply", [
    ("<summary>go</summary>", "go", "", "Received! Above in `<summary>` is the example.\n\nStill here."),
    ("<summary>go</summary>", "go", "", "If you cannot see `<summary>`, the rest must survive."),
    ("<summary>go</summary>", "go", "", "Use `<summary>example</summary>` and `<thinking>example</thinking>`."),
    ("", "", "", "`<summary>` and `<thinking>` are literal code, not protocol."),
    ("", "", "", "```html\n<summary>example</summary>\n<thinking>example</thinking>\n```\nTail."),
    ("<summary>go</summary>", "go", "", "Text before <summary>literal</summary> and <thinking>literal</thinking>."),
    (" \n<thinking>plan</thinking>\n<summary>go</summary>\n", "go", "plan", "Answer with `<thinking>` intact."),
    ("<summary>go</summary><thinking>plan</thinking>", "go", "plan", "Answer with `<summary>` intact."),
    ("<summary>go</summary><thinking>plan</thinking>", "go", "plan", ""),
])
def test_protocol_prefix_preserves_body_in_stream_and_final(chunk_size, prefix, summary, thinking, reply):
    rt, hooks, seen = _mount()
    deltas = []
    rt.ctx.events.on("assistant.delta", deltas.append)
    raw = prefix + reply
    response = SimpleNamespace(content=raw, thinking="")

    class Client:
        def chat(self, messages=None, tools=None):
            for i in range(0, len(raw), chunk_size):
                yield raw[i:i + chunk_size]
            return response

    try:
        client = Client()
        hooks.trigger("llm_before", {"turn": 1, "client": client})
        gen = client.chat()
        chunks = []
        while True:
            try:
                chunks.append(next(gen))
            except StopIteration as stop:
                assert stop.value is response
                break
        assert "".join(chunks) == raw
        assert "chat" not in client.__dict__
        expected = {"summary": summary, "thinking": thinking, "reply": reply}
        for part, text in expected.items():
            assert "".join(d["text"] for d in deltas if d["part"] == part) == text
        hooks.trigger("llm_after", {"turn": 1, "client": client, "response": response})
        final = dict(seen)["assistant.text"]
        assert final["text"] == raw
        assert {part: final[part] for part in expected} == expected
    finally:
        rt.remove("ga-events")
        rt.remove("ga-hooks")


def test_provider_thinking_takes_precedence_over_inline_protocol():
    rt, hooks, seen = _mount()
    try:
        response = SimpleNamespace(content="<thinking>inline</thinking><summary>go</summary>ok",
                                   thinking="provider thinking")
        hooks.trigger("llm_after", {"turn": 1, "response": response})
        final = dict(seen)["assistant.text"]
        assert final["thinking"] == "provider thinking"
        assert final["summary"] == "go"
        assert final["reply"] == "ok"
    finally:
        rt.remove("ga-events")
        rt.remove("ga-hooks")


def test_llm_stream_emits_deltas_and_unwraps():
    rt, hooks, seen = _mount()
    deltas = []
    rt.ctx.events.on("assistant.delta", deltas.append)

    class Client:
        def chat(self, messages=None, tools=None):
            for c in ("<sum", "mary>go</summ", "ary>\n\nhel", "lo"):
                yield c
            return SimpleNamespace(content="<summary>go</summary>hello")

    c = Client()
    hooks.trigger("llm_before", {"turn": 3, "client": c})
    assert "chat" in c.__dict__
    gen = c.chat(messages=[])
    assert "chat" not in c.__dict__            # one call only
    got = []
    try:
        while True:
            got.append(next(gen))
    except StopIteration as e:
        resp = e.value
    assert "".join(got) == "<summary>go</summary>\n\nhello"   # GA still sees the raw stream
    assert resp.content.endswith("hello")
    assert deltas == [{"turn": 3, "part": "summary", "text": "go"},
                      {"turn": 3, "part": "reply", "text": "hel"},
                      {"turn": 3, "part": "reply", "text": "lo"}]
    hooks.trigger("llm_before", {"turn": 4, "client": c})   # never consumed: llm_after restores
    hooks.trigger("llm_after", {"turn": 4, "client": c, "response": resp})
    assert "chat" not in c.__dict__
    rt.remove("ga-events")
    rt.remove("ga-hooks")
