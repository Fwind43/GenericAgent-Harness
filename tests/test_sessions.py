import queue
from types import SimpleNamespace as NS

import pytest

from ga_harness.sessions import Sessions


def agent():
    client = NS(backend=NS(name="one", history=[]), last_tools="")
    return NS(history=[], handler=None, llmclient=client, llmclients=[client],
              task_queue=queue.Queue(), is_running=False, all_outputs=[])


def test_sessions_isolation_and_cold_restart(tmp_path):
    path = tmp_path / "sessions.sqlite3"
    raw = agent()
    store = Sessions(raw, path)
    first = store.current()["id"]
    raw.history = ["first history"]
    raw.llmclient.backend.history = [{"role": "user", "content": "first"}]
    raw.handler = NS(working={"key_info": "first memory", "passed_sessions": ["past"], "private": 1})
    messages = [{"role": "user", "text": "first"}]
    store.save(messages)
    second = store.change("new")["id"]
    assert first != second and raw.history == [] and raw.handler is None
    raw.history = ["second history"]
    store.save([{"role": "user", "text": "second"}])
    assert store.change("select", first)["messages"] == messages
    assert raw.history == ["first history"]
    assert raw.llmclient.backend.history[0]["content"] == "first"
    assert raw.handler.working == {"key_info": "first memory", "passed_sessions": ["past"]}
    raw.history.append("not persisted")
    restored = agent()
    cold = Sessions(restored, path)
    assert cold.current()["id"] == first
    assert restored.history == ["first history"]
    assert len(cold.listing()) == 2
    cold.change("rename", first, "renamed")
    assert cold.current()["title"] == "renamed"
    cold.change("delete", second)
    assert len(cold.listing()) == 1
    with pytest.raises(ValueError, match="not found"):
        cold.change("select", second)
    assert cold.change("delete", first)["id"] != first
    assert restored.history == []


def test_crashed_run_is_not_replayed(tmp_path):
    path = tmp_path / "sessions.sqlite3"
    store = Sessions(agent(), path)
    store.save([{"role": "assistant", "status": "running", "turns": [
        {"status": "running", "tools": [{"status": "running"}]}]}])
    cold = Sessions(agent(), path)
    message = cold.current()["messages"][0]
    assert message["status"] == message["turns"][0]["status"] == "interrupted"
    assert message["turns"][0]["tools"][0]["status"] == "interrupted"
    assert Sessions(agent(), path).current()["messages"] == cold.current()["messages"]


def test_busy_and_invalid_operations_preserve_selection(tmp_path):
    raw = agent()
    store = Sessions(raw, tmp_path / "sessions.sqlite3")
    first = store.current()["id"]
    raw.task_queue.put("pending")
    with pytest.raises(RuntimeError):
        store.change("new")
    with pytest.raises(RuntimeError):
        store.save([])
    raw.task_queue.get()
    raw.task_queue.task_done()
    for action, sid, title in [("other", None, None), ("rename", first, " "), ("select", "missing", None)]:
        with pytest.raises(ValueError):
            store.change(action, sid, title)
        assert store.current()["id"] == first
    assert len(store.listing()) == 1


def test_reasoning_effort_is_per_conversation():
    from ga_harness.sessions import apply_effort, capture, restore
    backend = NS(reasoning_effort="medium", history=[], name="m")
    client = NS(backend=backend)
    agent = NS(llmclient=client, llmclients=[client], history=[], handler=None)
    restore(agent, {"effort": "high"})
    apply_effort(agent)
    assert backend.reasoning_effort == "high" and capture(agent)["effort"] == "high"
    restore(agent, {})  # new conversation falls back to the model's own setting
    apply_effort(agent)
    assert agent.gah_reasoning_effort is None and backend.reasoning_effort == "medium"
    restore(agent, {"effort": "bogus"})
    assert agent.gah_reasoning_effort is None


def test_sessions_unread_tracking(tmp_path):
    import sqlite3
    path = tmp_path / "sessions.sqlite3"
    store = Sessions(agent(), path)
    first = store.current()["id"]
    second = store.create()["id"]
    unread = lambda: {r["id"]: r["unread"] for r in store.listing()}
    assert unread() == {first: False, second: False}
    # Background write to a chat that is not on screen -> unread; write to the open chat -> read.
    store.save_for(second, [{"role": "assistant", "text": "done"}], {})
    store.save([{"role": "user", "text": "hi"}])
    assert unread() == {first: False, second: True}
    store.change("rename", second, "renamed")
    assert unread()[second] is True
    store.change("select", second)
    assert unread()[second] is False
    store.change("unread", first)
    assert unread()[first] is True and store.current()["id"] == second
    store.change("read", first)
    assert unread()[first] is False
    store.save_for(first, [{"role": "assistant", "text": "x"}], {})
    assert store.change("read_all")["id"] == second and not any(unread().values())
    # Pre-existing databases migrate with every chat read.
    with sqlite3.connect(path) as db:
        db.execute("ALTER TABLE sessions DROP COLUMN read_at")
    assert not any(r["unread"] for r in Sessions(agent(), path).listing())
