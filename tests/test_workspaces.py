import os
import time
from types import SimpleNamespace as NS

import pytest

from ga_harness.sessions import Sessions
from ga_harness.workspaces import Workspaces
from tests.test_sessions import agent


def setup(tmp_path):
    raw = agent()
    sessions = Sessions(raw, tmp_path / "sessions.sqlite3")
    return raw, sessions, Workspaces(sessions, tmp_path)


def project(ws, path, name="alpha", **fields):
    return ws.change(dict(action="create", name=name, workspace=str(path), **fields))


def test_scope_switch_isolation_and_restart(tmp_path):
    raw, sessions, ws = setup(tmp_path)
    initial = sessions.current()
    assert initial["workspace"] == str(tmp_path.resolve())
    a = project(ws, tmp_path)
    raw.history = ["private alpha"]
    sessions.save([{"role": "user", "text": "alpha conversation"}])
    b = project(ws, tmp_path, name="beta")
    assert a["project_id"] != b["project_id"]
    assert raw.history == [] and b["messages"] == []
    restored = ws.change({"action": "select", "id": a["project_id"]})
    assert restored["id"] == a["id"]
    assert raw.history == ["private alpha"]
    inherited = sessions.change("new")
    assert inherited["project_id"] == a["project_id"]
    other = tmp_path / "other"
    other.mkdir()
    plain = ws.change({"action": "workspace", "workspace": str(other)})
    assert plain["id"] != inherited["id"] and plain["project_id"] == ""
    assert plain["workspace"] == str(other.resolve()) and raw.history == []
    cold = Workspaces(Sessions(agent(), sessions.path), tmp_path)
    assert cold.sessions.current()["id"] == plain["id"]
    assert len(cold.projects()) == 2
    assert cold.change({"action": "select", "id": a["project_id"]})["project_id"] == a["project_id"]


def test_validation_and_optimistic_edit(tmp_path):
    _, sessions, ws = setup(tmp_path)
    original = sessions.current()["id"]
    for directory in ["relative", str(tmp_path / "missing"), "", None]:
        with pytest.raises(ValueError):
            ws.change({"action": "workspace", "workspace": directory})
        assert sessions.current()["id"] == original
    project(ws, tmp_path)
    p = ws.projects()[0]
    change = dict(p, action="update", name="edited")
    ws.change(change)
    assert ws.projects()[0]["name"] == "edited"
    with pytest.raises(RuntimeError, match="another tab"):
        ws.change(change)
    assert ws.projects()[0]["name"] == "edited"
    for bad in ["a/b", "x:y", "..", "dot."]:
        with pytest.raises(ValueError):
            project(ws, tmp_path, name=bad)
    assert len(ws.projects()) == 1


def test_request_scope_bind_inject_and_error_release(tmp_path):
    raw, sessions, ws = setup(tmp_path)
    project(ws, tmp_path)
    cwd = os.getcwd()
    handler = NS(parent=raw, cwd="old")
    messages = [{"role": "system", "content": "original\ncwd = old (./)"}]
    g = dict(handler=handler, messages=messages)
    def run(request):
        assert sessions.reserved
        for change in [lambda: sessions.change("new"), lambda: ws.change({"action": "select", "id": ""})]:
            with pytest.raises(RuntimeError):
                change()
        ws.bind(g, lambda value: value)
        assert handler.cwd == str(tmp_path.resolve())
        for _ in range(3):
            ws.inject(g, lambda value: value)
        text = messages[0]["content"]
        assert text.count("[Harness execution context]") == 1
        assert raw._ga_project_mode_name == "alpha"
        assert "cwd = old" not in text
        assert os.getcwd() == cwd
        raise ValueError("failed request")
    with pytest.raises(ValueError, match="failed request"):
        ws.request({}, run)
    assert not sessions.reserved and ws.active is None
    project(ws, tmp_path, name="beta")
    ws.request({}, lambda _: ws.inject(g, lambda value: value))
    assert raw._ga_project_mode_name == "beta"
    ws.change({"action": "enter"})
    ws.request({}, lambda _: None)
    assert raw._ga_project_mode_name is None


def test_timeout_keeps_scope_until_queue_drained(tmp_path):
    raw, sessions, ws = setup(tmp_path)
    def timeout(_):
        raw.task_queue.put("still executing")
        raise TimeoutError("slow abort")
    try:
        with pytest.raises(TimeoutError):
            ws.request({}, timeout)
        assert sessions.reserved and ws.active
        with pytest.raises(RuntimeError):
            ws.request({}, lambda _: None)
        with pytest.raises(RuntimeError):
            sessions.change("new")
    finally:
        raw.task_queue.get_nowait()
        raw.task_queue.task_done()
    for _ in range(100):
        if not sessions.reserved:
            break
        time.sleep(.01)
    assert not sessions.reserved and ws.active is None
    sessions.change("new")


def test_injection_without_system_is_idempotent(tmp_path):
    raw, _, ws = setup(tmp_path)
    g = dict(handler=NS(parent=raw), messages=[{"role": "user", "content": "hi"}])
    def run(_):
        for _ in range(3):
            ws.inject(g, lambda value: value)
    ws.request({}, run)
    assert g["messages"][0]["content"].count("[Harness execution context]") == 1


def test_enter_binds_empty_conversation_or_opens_new(tmp_path):
    raw, sessions, ws = setup(tmp_path)
    a = project(ws, tmp_path)
    blank = sessions.change("new", project_id="")
    entered = ws.change({"action": "enter", "id": a["project_id"]})
    assert entered["id"] == blank["id"] and entered["project_id"] == a["project_id"]
    raw.history = ["alpha talk"]
    sessions.save([{"role": "user", "text": "hello"}])
    other = tmp_path / "other"
    other.mkdir()
    moved = ws.change({"action": "enter", "workspace": str(other)})
    assert moved["id"] != blank["id"] and moved["project_id"] == ""
    assert moved["workspace"] == str(other.resolve()) and raw.history == []
    kept = [s for s in sessions.listing() if s["id"] == blank["id"]][0]
    assert kept["project_id"] == a["project_id"]
    plain = ws.change({"action": "enter", "id": ""})
    assert plain["id"] == moved["id"] and plain["workspace"] == str(tmp_path.resolve())
    with pytest.raises(ValueError):
        ws.change({"action": "enter", "id": "missing"})
