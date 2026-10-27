"""Workspace web extension against an isolated HTTP server (no GA/keys)."""
from pathlib import Path

import pytest

from ga_harness.kernel.loader import discover, mount
from ga_harness.sessions import Sessions
from ga_harness.workspaces import Workspaces
from tests.test_sessions import agent
from tests.test_ui_web import _start, _req, _wait_idle

PLUGINS = Path(__file__).resolve().parents[1] / "ga_harness" / "plugins"


@pytest.fixture
def workspace_app(tmp_path):
    rt, fe, off, base = _start(tmp_path)
    fe.sessions = Sessions(agent(), tmp_path / "sessions.sqlite3")
    ws = Workspaces(fe.sessions, tmp_path)
    fe.messages = fe.sessions.current()["messages"]
    rt.ctx.provide("workspaces", ws)
    mount(rt, [{"name": name, "disabled": False, "config": {}}
               for name in ("web-workspaces", "web-sessions", "web-theme")], discover([PLUGINS]))
    assert rt.handles["web-workspaces"].state == "active"
    try:
        yield rt, fe, ws, base
    finally:
        rt.ctx.get("agent").abort()
        off()
        rt.dispose()


def test_workspace_http_isolation_conflict_busy_and_unload(workspace_app, tmp_path):
    rt, fe, ws, base = workspace_app
    url = base + "api/p/web-workspaces"
    original = _req(base + "api/state")[1]["session_id"]
    body = {"action": "create", "name": "alpha", "workspace": str(tmp_path)}
    assert _req(url, body, {"Origin": "https://foreign.invalid"})[0] == 403
    assert ws.projects() == []
    status, state = _req(url, body)
    assert status == 200
    first = state["session_id"]
    project = state["scope"]["project"]
    assert first == original and state["messages"] == []  # empty conversation is bound in place
    assert project["name"] == "alpha" and "rules" not in project
    edit = {**project, "action": "update", "name": "edited"}
    assert _req(url, edit)[0] == 200
    assert _req(url, edit)[0] == 409
    assert _req(url, {"action": "workspace", "workspace": "relative"})[0] == 400
    assert _req(base + "api/run", {"task": "wait"})[0] == 202
    assert _req(url)[0] == 200
    assert _req(url, {"action": "select", "id": ""})[0] == 409
    assert _req(base + "api/abort", {})[0] == 202
    _wait_idle(base)
    status, state = _req(url, {"action": "workspace", "workspace": str(tmp_path)})
    assert status == 200 and state["session_id"] != first
    assert state["scope"]["project"] is None and state["messages"] == []
    status, state = _req(url, {"action": "select", "id": project["id"]})
    assert status == 200 and state["session_id"] == first
    assert state["scope"]["project"]["name"] == "edited"
    assert state["messages"][0]["text"] == "wait"
    assert _req(base + "api/state")[1]["scope"] == _req(url)[1]
    rt.remove("web-workspaces")
    assert _req(url)[0] == 404
    assert "scope" not in _req(base + "api/state")[1]
    assert ws.current()["project_id"] == project["id"]


def test_workspace_http_storage_error_is_redacted(workspace_app, monkeypatch):
    _, _, ws, base = workspace_app
    def fail(_):
        raise OSError("private storage details")
    monkeypatch.setattr(ws, "change", fail)
    status, result = _req(base + "api/p/web-workspaces", {"action": "select"})
    assert status == 503 and "private" not in result["error"]
