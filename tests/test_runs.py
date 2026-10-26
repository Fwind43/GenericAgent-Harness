"""Focused source regressions for isolated execution (no GA credentials needed)."""
from types import SimpleNamespace

import pytest

from ga_harness.runs import Runs
from ga_harness.sessions import Sessions
from ga_harness.workspaces import Workspaces


def make_agent():
    backend = SimpleNamespace(history=[], name="fixture-model")
    client = SimpleNamespace(backend=backend, last_tools="")
    return SimpleNamespace(llmclients=[client], llmclient=client, history=[],
                           handler=None, all_outputs=[], is_running=False)


@pytest.fixture
def stores(tmp_path):
    sessions = Sessions(make_agent(), tmp_path / "sessions.sqlite")
    scope = Workspaces(sessions, tmp_path)
    sessions.parallel = True
    return sessions, scope


def test_explicit_write_does_not_follow_selection(stores):
    sessions, scope = stores
    first = sessions.current()
    second = sessions.create(select=True)
    messages = [{"role": "assistant", "text": "first result"}]
    state = {"history": ["first context"]}
    sessions.save_for(first["id"], messages, state)
    assert sessions.current()["id"] == second["id"]
    assert sessions.current()["messages"] == []
    assert sessions.get(first["id"])["messages"] == messages
    assert sessions.get(first["id"])["state"] == state
    assert scope.context(first["id"])["workspace"] == first["workspace"]


def test_child_inherits_scope_not_history(stores):
    sessions, _ = stores
    parent = sessions.current()
    sessions.save_for(parent["id"], [{"role": "user", "text": "parent"}], {})
    child = sessions.create(parent_id=parent["id"])
    assert child["parent_id"] == parent["id"]
    assert child["workspace"] == parent["workspace"]
    assert child["project_id"] == parent["project_id"]
    assert child["messages"] == [] and child["state"] == {}
    assert sessions.current()["id"] == parent["id"]
    with pytest.raises(ValueError, match="inherit"):
        sessions.create(parent_id=parent["id"], workspace="different")


class ClosedConnection:
    def close(self):
        pass


class FailedProcess:
    def start(self):
        raise RuntimeError("sensitive configuration must not escape")


class FailedSpawn:
    def Pipe(self, duplex=True):
        return ClosedConnection(), ClosedConnection()

    def Process(self, **kwargs):
        return FailedProcess()


def test_spawn_failure_settles_without_emitting_under_session_lock(stores):
    sessions, scope = stores
    emitted = []

    def emit(name, data):
        # CPython's RLock ownership probe catches the Web lock-inversion regression.
        assert not sessions.lock._is_owned()
        emitted.append((name, data))

    runs = Runs(sessions, scope, lambda: [], emit=emit, process_context=FailedSpawn())
    sid = sessions.current()["id"]
    record = runs.start("task", session_id=sid)
    assert record["status"] == "error"
    assert record["error"] == "Worker could not start"
    assert runs.active_for(sid) is None and sid not in sessions.active
    assert not runs.busy
    assert sessions.get(sid)["messages"][-1]["status"] == "error"
    events = runs.events(record["id"])
    assert [event["kind"] for event in events] == ["run.started", "run.finished"]
    assert [event["seq"] for event in events] == [1, 2]
    assert len(runs.events(record["id"], after=1)) == 1
    assert [name for name, _ in emitted] == ["run.started", "run.finished"]
    # A repeat cancel must leave the durable terminal record and events unchanged.
    runs.cancel(record["id"])
    runs.cancel(record["id"])
    assert runs.get(record["id"]) == record
    assert runs.events(record["id"]) == events
    runs.close()


def reserve(sessions, sid, run_id):
    with sessions._db() as db:
        db.execute("INSERT INTO runs(id,session_id,source,status,workspace,project_id,created) "
                   "VALUES(?,?,'test','running','','',0)", (run_id, sid))
    sessions.active.add(sid)


def test_active_session_requires_owner_and_cannot_be_deleted(stores):
    sessions, scope = stores
    runs = Runs(sessions, scope, lambda: [])
    sid = sessions.current()["id"]
    reserve(sessions, sid, "owner")
    with pytest.raises(RuntimeError):
        sessions.save_for(sid, [], {}, run_id="other")
    with pytest.raises(RuntimeError):
        sessions.change("delete", sid=sid)
    sessions.save_for(sid, [{"role": "assistant", "text": "owned"}], {}, run_id="owner")
    assert sessions.get(sid)["messages"][-1]["text"] == "owned"
    assert runs.active_for(sid)["id"] == "owner"


def test_recovery_settles_unselected_sessions_without_retry(stores):
    sessions, scope = stores
    first = sessions.current()
    second = sessions.create(select=True)
    messages = [{"role": "assistant", "text": "partial", "status": "running",
                 "turns": [{"status": "running", "tools": []}]}]
    sessions.save_for(first["id"], messages, {})
    runs = Runs(sessions, scope, lambda: [])
    reserve(sessions, first["id"], "interrupted-run")
    sessions.active.clear()  # A new host has no in-memory worker reservations.
    recovered = Sessions(make_agent(), sessions.path)
    recovered_scope = Workspaces(recovered, scope.default_workspace)
    recovered_runs = Runs(recovered, recovered_scope, lambda: [])
    assert recovered.current()["id"] == second["id"]
    assert recovered.get(first["id"])["messages"][-1]["status"] == "interrupted"
    assert recovered_runs.get("interrupted-run")["status"] == "interrupted"
    assert not recovered_runs.busy
    assert recovered_runs.events("interrupted-run")[-1]["kind"] == "run.finished"
    assert len(runs.listing()) == 1
