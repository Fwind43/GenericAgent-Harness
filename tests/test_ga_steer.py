from pathlib import Path
from types import SimpleNamespace

from ga_harness.kernel import Runtime
from ga_harness.kernel.loader import discover
from ga_harness.sessions import capture, restore

ROOT = Path(__file__).resolve().parents[1]
PLUGINS = ROOT / "ga_harness" / "plugins"


class _FakeHost:
    def __init__(self):
        self.handlers = {}
        self.events = []

    def on_push(self, kind, fn):
        self.handlers[kind] = fn
        return lambda: self.handlers.pop(kind, None)

    def push(self, kind, data):
        fn = self.handlers.get(kind)
        if fn:
            fn(data)

    def emit(self, name, data):
        self.events.append((name, data))


class _FakeHandler:
    def __init__(self, history=None):
        self._done_hooks = []
        self.history_info = list(history) if history is not None else []
        self.received_prompts = []

    def turn_end_callback(self, response, tool_calls, tool_results, turn, next_prompt, exit_reason):
        self.received_prompts.append((turn, next_prompt, exit_reason))
        summary = getattr(response, "summary", f"turn-{turn}")
        self.history_info.append(f"[Agent] {summary}")
        return next_prompt


def _mount_steer():
    rt = Runtime()
    host = _FakeHost()
    rt.ctx.provide("ga.hooks", object())
    rt.ctx.provide("run.host", host)
    rt.add(discover([PLUGINS])["ga-steer"].to_plugin(), {})
    return rt, host


def _call_hook(rt, name, gactx):
    return rt.ctx.waterfall(name, gactx, lambda c: c)


def test_mid_task_steer_appended_to_prompt_and_history_in_order():
    rt, host = _mount_steer()
    handler = _FakeHandler(history=["[USER]: initial request"])

    _call_hook(rt, "ga.agent_before", {"handler": handler})
    host.push("steer", {"id": "s1", "text": "also check edge cases"})

    out = handler.turn_end_callback(
        SimpleNamespace(summary="did step 1"), [], [], 1, "tool output", {}
    )
    assert "tool output" in out
    assert "also check edge cases" in out
    assert handler._done_hooks == []
    assert handler.history_info == [
        "[USER]: initial request",
        "[Agent] did step 1",
        "[USER]: also check edge cases",
    ]
    assert host.events == [
        ("steer.applied", {
            "ids": ["s1"],
            "notes": [{"kind": "steer", "text": "also check edge cases", "turn": 1}],
        })
    ]

    _call_hook(rt, "ga.agent_after", {"handler": handler})
    assert len(host.events) == 1
    rt.remove("ga-steer")


def test_done_hooks_steer_recorded_in_history_and_session_snapshot():
    rt, host = _mount_steer()
    handler = _FakeHandler(history=["[USER]: first task"])

    _call_hook(rt, "ga.agent_before", {"handler": handler})
    host.push("steer", {"id": "s2", "text": "one more check before finishing"})
    assert len(handler._done_hooks) == 1

    # Simulate GA's agent_loop popping _done_hooks right before turn_end_callback.
    popped = handler._done_hooks.pop(0)
    assert "one more check before finishing" in popped
    handler.turn_end_callback(
        SimpleNamespace(summary="finished first task"),
        [], [], 2, popped, {"result": "CURRENT_TASK_DONE"},
    )
    assert handler.history_info == [
        "[USER]: first task",
        "[Agent] finished first task",
        "[USER]: one more check before finishing",
    ]
    assert host.events == [
        ("steer.applied", {
            "ids": ["s2"],
            "notes": [{"kind": "steer", "text": "one more check before finishing", "turn": 2}],
        })
    ]

    # Verify session capture & restore preserve the steered message via handler.history_info.
    agent = SimpleNamespace(history=[], handler=handler, llmclient=None, llmclients=[])
    snap = capture(agent)
    assert snap["history"] == handler.history_info
    restored = SimpleNamespace(history=[], handler=None, llmclient=None, llmclients=[])
    restore(restored, snap)
    assert restored.history == handler.history_info

    _call_hook(rt, "ga.agent_after", {"handler": handler})
    rt.remove("ga-steer")


def test_done_hooks_pop_race_with_second_steer_keeps_both_distinct():
    rt, host = _mount_steer()
    handler = _FakeHandler(history=["[USER]: start"])

    _call_hook(rt, "ga.agent_before", {"handler": handler})
    host.push("steer", {"id": "s1", "text": "first steer"})
    assert len(handler._done_hooks) == 1

    # GA pops s1 from _done_hooks; before turn_end_callback runs, s2 arrives.
    popped = handler._done_hooks.pop(0)
    host.push("steer", {"id": "s2", "text": "second steer"})

    # s1 must be marked applied immediately; s2 must remain pending in _done_hooks.
    assert host.events == [
        ("steer.applied", {
            "ids": ["s1"],
            "notes": [{"kind": "steer", "text": "first steer"}],
        })
    ]
    assert len(handler._done_hooks) == 1
    assert "second steer" in handler._done_hooks[0]

    # Turn 1 finishes with exit_reason (CURRENT_TASK_DONE -> continued by popped s1).
    handler.turn_end_callback(
        SimpleNamespace(summary="turn 1"), [], [], 1, popped, {"result": "CURRENT_TASK_DONE"}
    )
    assert handler.history_info == [
        "[USER]: start",
        "[Agent] turn 1",
        "[USER]: first steer",
    ]
    # s2 is still pending for turn 2.
    assert len(handler._done_hooks) == 1

    # Turn 2 delivers s2 mid-task.
    out2 = handler.turn_end_callback(
        SimpleNamespace(summary="turn 2"), [], [], 2, "next", {}
    )
    assert "second steer" in out2
    assert handler.history_info == [
        "[USER]: start",
        "[Agent] turn 1",
        "[USER]: first steer",
        "[Agent] turn 2",
        "[USER]: second steer",
    ]
    assert host.events[1] == (
        "steer.applied",
        {"ids": ["s2"], "notes": [{"kind": "steer", "text": "second steer", "turn": 2}]},
    )

    _call_hook(rt, "ga.agent_after", {"handler": handler})
    rt.remove("ga-steer")


def test_unused_steer_not_written_to_history():
    rt, host = _mount_steer()
    handler = _FakeHandler(history=["[USER]: start"])

    _call_hook(rt, "ga.agent_before", {"handler": handler})
    host.push("steer", {"id": "s-unused", "text": "never delivered"})

    # Task exits immediately without consuming _done_hooks (e.g. EXITED / abort).
    handler.turn_end_callback(
        SimpleNamespace(summary="exited"), [], [], 1, "", {"result": "EXITED"}
    )
    _call_hook(rt, "ga.agent_after", {"handler": handler})

    assert handler.history_info == ["[USER]: start", "[Agent] exited"]
    assert host.events == [
        ("steer.unused", {"ids": ["s-unused"], "texts": ["never delivered"]})
    ]
    rt.remove("ga-steer")


def test_history_entry_flattens_newlines_and_truncates_long_text():
    rt, host = _mount_steer()
    handler = _FakeHandler()

    _call_hook(rt, "ga.agent_before", {"handler": handler})
    multiline = "line one\nline two\nline three"
    long_text = "A" * 150 + "MIDDLE" + "Z" * 150
    host.push("steer", {"id": "m1", "text": multiline})
    host.push("steer", {"id": "m2", "text": long_text, "raw": True})

    handler.turn_end_callback(SimpleNamespace(summary="ok"), [], [], 1, "next", {})
    assert handler.history_info[0] == "[Agent] ok"
    assert handler.history_info[1] == "[USER]: line one line two line three"
    assert handler.history_info[2] == f"[USER]: {'A' * 100} ... {'Z' * 100}"
    assert "\n" not in handler.history_info[1]
    assert "\n" not in handler.history_info[2]

    _call_hook(rt, "ga.agent_after", {"handler": handler})
    rt.remove("ga-steer")
