from ga_harness.sessions import Sessions
from tests.test_sessions import agent
from tests.test_ui_web import _start, _req, _wait_idle


def test_session_http_switch_restart_and_busy_guard(tmp_path):
    db = tmp_path / "sessions.sqlite3"
    rt, fe, off, base = _start(tmp_path)
    fe.sessions = Sessions(agent(), db)
    first = fe.sessions.current()["id"]
    try:
        assert _req(base + "api/run", {"task": "hello"})[0] == 202
        saved = _wait_idle(base)
        assert saved["sessions"][0]["title"] == "hello"
        code, fresh = _req(base + "api/sessions", {"action": "new"})
        assert code == 200 and fresh["messages"] == []
        assert fresh["session_id"] != first
        code, old = _req(base + "api/sessions", {"action": "select", "id": first})
        assert code == 200 and old["messages"] == saved["messages"]
        assert _req(base + "api/sessions", {"action": "rename", "id": first, "title": "renamed"})[0] == 200
        assert _req(base + "api/run", {"task": "wait"})[0] == 202
        assert _req(base + "api/sessions", {"action": "new"})[0] == 409
        assert _req(base + "api/abort", {})[0] == 202
        _wait_idle(base)
    finally:
        off()
        rt.dispose()
    cold = Sessions(agent(), db)
    assert cold.current()["id"] == first
    assert cold.current()["title"] == "renamed"
    assert cold.current()["messages"][-1]["status"] == "aborted"
    assert len(cold.listing()) == 2


def test_session_write_failure_does_not_start_agent(tmp_path, monkeypatch):
    rt, fe, off, base = _start(tmp_path)
    fe.sessions = Sessions(agent(), tmp_path / "sessions.sqlite3")
    fe.sessions.current()
    def fail(_):
        raise OSError("synthetic storage failure")
    monkeypatch.setattr(fe.sessions, "save", fail)
    try:
        assert _req(base + "api/run", {"task": "hello"})[0] == 503
        assert fe.messages == [] and not fe.running
        assert rt.ctx.get("agent").calls == []
    finally:
        off()
        rt.dispose()
