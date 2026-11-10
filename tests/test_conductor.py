"""Conductor delivery and durable handoff contracts (no live model required)."""
import importlib
import json

import pytest


@pytest.fixture
def conductor():
    return importlib.import_module("ga_harness.plugins.conductor.main")


def message(reply="Final delivery", *, status="done", tools=None):
    return {
        "status": "done", "content": "Raw tool transcript must not become the result",
        "turns": [
            {"status": "done", "reply": "Earlier plan", "tools": []},
            {"status": status, "reply": reply, "tools": tools or []},
        ],
    }


def test_delivery_uses_only_last_structured_reply(conductor):
    result = conductor._message_result(message("  Evidence and remaining risks  "))
    assert result == {
        "result": "Evidence and remaining risks",
        "result_complete": True, "result_source": "final_turn",
    }
    assert conductor._message_text(message()) == "Final delivery"


@pytest.mark.parametrize("value", [
    None, "raw transcript", {"content": "raw transcript"}, {"turns": []},
    {"turns": [None]}, message(""), message("   "),
    message("Still executing", tools=[{"name": "file_read"}]),
    message("Still executing", tools=[{"name": "no_tool"}, {"name": "code_run"}]),
])
def test_missing_delivery_never_falls_back_to_transcript_or_plan(conductor, value):
    assert conductor._message_result(value) == {
        "result": "", "result_complete": False, "result_source": "missing_final",
    }


def test_no_tool_final_reply_is_a_delivery(conductor):
    result = conductor._message_result(message(tools=[{"name": "no_tool"}]))
    assert result["result_complete"] is True
    assert result["result"] == "Final delivery"


@pytest.mark.parametrize("turn_status,message_status", [
    ("running", "done"), ("error", "done"), ("done", "aborted"),
])
def test_partial_delivery_is_explicit(conductor, turn_status, message_status):
    value = message("Partial evidence", status=turn_status)
    value["status"] = message_status
    result = conductor._message_result(value)
    assert result["result"] == "Partial evidence"
    assert result["result_complete"] is False
    assert result["result_source"] == "partial_turn"


def test_clipped_delivery_keeps_tail_evidence(conductor):
    text = "H" * 80 + "M" * 100 + "EVIDENCE: verified; RISK: untested"
    preview = conductor._clip(text, 60)
    assert preview.startswith(text[:40])
    assert preview.endswith(text[-20:])
    assert "chars omitted; use conductor_inspect" in preview
    assert conductor._clip("short", 60) == "short"
    assert conductor._clip("X" * 60, 60) == "X" * 60


def test_checkpoint_and_delivery_survive_store_reload(conductor, tmp_path):
    path = tmp_path / "conductor.json"
    store = conductor.Store(path)
    plan = {
        "stage": 3, "goal": "Deliver a verified change", "next_step": "Review evidence",
        "status": "waiting_external", "reason": "Waiting for the build monitor",
        "history": [{"stage": 2, "handoff": "Implementation complete", "finished": 123}],
    }
    store.data["progress"]["parent"] = plan
    store.data["tasks"]["task"] = {
        "status": "done", "stage": 2, "result": "Delivery with evidence",
        "result_complete": True, "result_source": "final_turn",
    }
    store.save()
    loaded = conductor.Store(path)
    assert loaded.data["progress"]["parent"] == plan
    assert loaded.data["tasks"]["task"] == store.data["tasks"]["task"]
    loaded.save()
    assert conductor.Store(path).data == loaded.data


def test_legacy_results_are_not_mistaken_for_final_deliveries(conductor, tmp_path):
    path = tmp_path / "conductor.json"
    path.write_text(json.dumps({"tasks": {
        "old": {"status": "done", "result": "raw historical tool output"},
        "running": {"status": "running", "result": "unfinished transcript"},
    }}), encoding="utf-8")
    store = conductor.Store(path)
    for task in store.data["tasks"].values():
        assert task["result"] == ""
        assert task["result_complete"] is False
        assert task["result_source"] == "legacy_unavailable"
    assert store.data["tasks"]["running"]["status"] == "interrupted"
    assert store.data["tasks"]["running"]["finished"] > 0
    assert store.data["progress"] == {}


@pytest.fixture
def harness(conductor, tmp_path, monkeypatch):
    """Wire the real RPC/events to inert services; never start timers or workers."""
    from types import SimpleNamespace

    store = conductor.Store(tmp_path / "conductor.json")
    store.data["enabled"]["parent"] = True
    store.data["active"]["parent"] = True
    monkeypatch.setattr(conductor, "Store", lambda path: store)
    timers, callbacks, services, cleanup = [], {}, {}, []

    class Timer:
        def __init__(self, delay, callback, args=(), kwargs=None):
            self.delay, self.callback = delay, callback
            self.args, self.kwargs = args, kwargs or {}

        def start(self):
            timers.append(self)

    monkeypatch.setattr(conductor.threading, "Timer", Timer)

    def register_rpc(name, callback):
        services[name] = callback
        return lambda: None

    services.update({
        "web.host": SimpleNamespace(
            frontend=SimpleNamespace(snapshot=lambda: {}, broadcast=lambda *args: None),
            register=lambda *args, **kwargs: lambda: None,
        ),
        "runs": SimpleNamespace(
            register_rpc=register_rpc,
            register_worker_plugin=lambda name: lambda: None,
            active_for=lambda sid: None,
        ),
        "sessions": SimpleNamespace(path=tmp_path / "sessions.json"),
    })
    ctx = SimpleNamespace(
        get=services.get, provide=services.__setitem__, on=callbacks.__setitem__,
        scope=SimpleNamespace(add=cleanup.append),
    )
    conductor.apply(ctx, {})

    def call(op, **body):
        return services["conductor"]({"session_id": "parent", "op": op, **body})

    def finish(source=None, status="done"):
        callbacks["run.finished"]({
            "session_id": "parent", "run_id": "parent-run",
            "run": {"status": status, "source": source or conductor.SOURCE},
        })

    yield SimpleNamespace(call=call, finish=finish, store=store, timers=timers,
                          services=services)
    for close in reversed(cleanup):
        if callable(close):
            close()


def task_record(index=0, *, resolved=True, review="verified", stage=1):
    return {
        "id": f"task-{index}", "parent": "parent", "child": f"child-{index}",
        "title": "Synthetic task", "objective": "Return verifiable evidence",
        "created": index, "status": "done", "stage": stage, "runs": 1,
        "resolved": resolved, "review": review, "acked": True, "notified": True,
        "result": "Final evidence", "result_complete": True, "result_source": "final_turn",
    }


@pytest.mark.parametrize("reuse_body", [{}, {"reuse_task": None}, {"reuse_task": ""}])
@pytest.mark.parametrize("isolate", [False, True])
def test_dispatch_empty_reuse_creates_new_session(conductor, harness, tmp_path,
                                                 monkeypatch, reuse_body, isolate):
    created, started = [], []
    workspace = str(tmp_path.resolve())

    def create(**kwargs):
        created.append(kwargs)
        return {"id": "new-child", "workspace": kwargs["workspace"]}

    def start(text, **kwargs):
        started.append((text, kwargs))
        return {"id": "new-run"}

    monkeypatch.setattr(harness.services["sessions"], "create", create, raising=False)
    monkeypatch.setattr(harness.services["runs"], "start", start, raising=False)
    monkeypatch.setattr(conductor, "_add_worktree", lambda *args: (
        workspace, "test-branch", workspace, "test-base", workspace))
    result = harness.call("dispatch", objective="Return evidence", workspace=workspace,
                          isolate=isolate, **reuse_body)
    task = harness.store.data["tasks"][result["task"]["id"]]
    assert len(created) == len(started) == 1
    assert created[0]["workspace"] == workspace
    assert started[0][1]["session_id"] == "new-child"
    assert task["status"] == "running"
    assert "reused_from" not in task
    assert bool(task.get("worktree")) is isolate


@pytest.mark.parametrize("conflict", ["workspace", "isolate"])
def test_dispatch_real_reuse_still_rejects_workspace_override(harness, tmp_path, conflict):
    body = {"workspace": str(tmp_path.resolve())} if conflict == "workspace" else {"isolate": True}
    with pytest.raises(ValueError, match="reuse_task cannot be combined"):
        harness.call("dispatch", objective="Continue task", reuse_task="task-0", **body)
    assert not harness.store.data["tasks"]


def test_stage_budget_rolls_over_without_deleting_history(conductor, harness):
    tasks = harness.store.data["tasks"]
    for i in range(conductor.MAX_TOTAL):
        task = task_record(i)
        tasks[task["id"]] = task
    before = harness.call("role")
    assert before["total"] == before["stage_total"] == conductor.MAX_TOTAL
    with pytest.raises(RuntimeError, match="stage task limit"):
        harness.call("dispatch", objective="Another task")
    after = harness.call("checkpoint", action="advance", goal="Ship the change",
                         handoff="Prior tasks verified", next_step="Review integration")
    assert after["progress"]["stage"] == 2
    assert after["stage_total"] == 0
    assert after["total"] == conductor.MAX_TOTAL
    assert len(tasks) == conductor.MAX_TOTAL
    assert after["progress"]["history"][0]["handoff"] == "Prior tasks verified"
    saved = json.loads(harness.store.path.read_text(encoding="utf-8"))
    assert saved["progress"]["parent"] == after["progress"]


def test_stage_advance_requires_closure_and_an_explicit_handoff(harness):
    task = task_record(resolved=False)
    harness.store.data["tasks"][task["id"]] = task
    with pytest.raises(RuntimeError, match="resolve every task"):
        harness.call("checkpoint", action="advance", goal="Goal",
                     handoff="Handoff", next_step="Next")
    harness.call("resolve", task_id=task["id"])
    for body in (
        {"goal": "Goal", "next_step": "Next"},
        {"goal": "Goal", "handoff": "Handoff"},
        {"handoff": "Handoff", "next_step": "Next"},
    ):
        with pytest.raises(ValueError):
            harness.call("checkpoint", action="advance", **body)
    assert harness.call("role")["progress"]["stage"] == 1
    assert harness.call("role")["progress"]["history"] == []


def test_stage_handoff_history_is_bounded(conductor, harness):
    for i in range(conductor.STAGE_HISTORY + 2):
        result = harness.call("checkpoint", action="advance", goal="Goal",
                              handoff=f"Stage {i + 1} complete", next_step="Next")
    history = result["progress"]["history"]
    assert len(history) == conductor.STAGE_HISTORY
    assert history[0]["stage"] == 3
    assert history[-1]["stage"] == conductor.STAGE_HISTORY + 2


def test_repeated_reviews_and_checkpoints_do_not_defeat_idle_guard(conductor, harness):
    task = task_record(resolved=False)
    harness.store.data["tasks"][task["id"]] = task
    for i in range(conductor.ACTIVE_IDLE_LIMIT):
        harness.call("review", task_id=task["id"], verdict="verified", basis=f"Same evidence {i}")
        harness.call("checkpoint", action="update", goal="Same goal", next_step=f"Plan {i}")
        harness.finish()
    plan = harness.call("role")["progress"]
    assert plan["status"] == "paused"
    assert "no task progress" in plan["reason"]
    saved = json.loads(harness.store.path.read_text(encoding="utf-8"))
    assert saved["progress"]["parent"]["status"] == "paused"


def test_repeated_resolve_does_not_defeat_idle_guard(conductor, harness):
    task = task_record()
    harness.store.data["tasks"][task["id"]] = task
    for _ in range(conductor.ACTIVE_IDLE_LIMIT):
        harness.call("resolve", task_id=task["id"])
        harness.finish()
    assert harness.call("role")["progress"]["status"] == "paused"


def test_actual_review_progress_resets_idle_counter(conductor, harness):
    task = task_record(resolved=False, review="pending")
    harness.store.data["tasks"][task["id"]] = task
    for _ in range(conductor.ACTIVE_IDLE_LIMIT - 1):
        harness.finish()
    harness.call("review", task_id=task["id"], verdict="verified", basis="Evidence inspected")
    harness.finish()
    assert harness.call("role")["progress"]["status"] != "paused"
    for _ in range(conductor.ACTIVE_IDLE_LIMIT):
        harness.finish()
    assert harness.call("role")["progress"]["status"] == "paused"


def test_wait_states_require_real_work_and_external_wait_does_not_spin(conductor, harness):
    with pytest.raises(RuntimeError, match="no child is running"):
        harness.call("checkpoint", action="update", status="waiting_children")
    with pytest.raises(RuntimeError, match="live reflect event source"):
        harness.call("checkpoint", action="update", status="waiting_external", reason="No source")
    source = {"id": "source", "parent": "parent", "status": "waiting"}
    harness.store.data["reflections"]["source"] = source
    harness.call("checkpoint", action="update", status="waiting_external", reason="Monitor build")
    for _ in range(conductor.ACTIVE_IDLE_LIMIT + 1):
        harness.finish()
    assert harness.call("role")["progress"]["status"] == "waiting_external"
    assert not any(t.name == "conductor-continue" for t in harness.timers)
    source["status"] = "stopped"
    harness.finish()
    assert harness.call("role")["progress"]["status"] == "active"


def test_finish_stays_terminal_until_new_user_input(harness):
    harness.call("finish", status="done")
    harness.finish()
    harness.finish()
    assert harness.call("role")["progress"]["status"] == "done"
    harness.finish(source="web")
    assert harness.call("role")["progress"]["status"] == "active"
