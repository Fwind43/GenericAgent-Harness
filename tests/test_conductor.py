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

        def cancel(self):
            self.cancelled = True

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
        "sessions": SimpleNamespace(path=tmp_path / "sessions.json", get=lambda sid: {"messages": []}),
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
                          services=services, callbacks=callbacks, cleanup=cleanup, ctx=ctx)
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
        harness.timers.clear()
        harness.finish()
    plan = harness.call("role")["progress"]
    assert plan["status"] == "idle_backoff"
    assert "no task progress" in plan["reason"]
    assert plan["next_continue_at"] > 0
    assert any(t.name == "conductor-continue" and t.delay == conductor.ACTIVE_IDLE_INTERVAL
               for t in harness.timers)
    saved = json.loads(harness.store.path.read_text(encoding="utf-8"))
    assert saved["progress"]["parent"]["status"] == "idle_backoff"


def test_repeated_resolve_does_not_defeat_idle_guard(conductor, harness):
    task = task_record()
    harness.store.data["tasks"][task["id"]] = task
    for _ in range(conductor.ACTIVE_IDLE_LIMIT):
        harness.call("resolve", task_id=task["id"])
        harness.timers.clear()
        harness.finish()
    assert harness.call("role")["progress"]["status"] == "idle_backoff"
    assert any(t.name == "conductor-continue" and t.delay == conductor.ACTIVE_IDLE_INTERVAL
               for t in harness.timers)


def test_actual_review_progress_resets_idle_counter(conductor, harness):
    task = task_record(resolved=False, review="pending")
    harness.store.data["tasks"][task["id"]] = task
    for _ in range(conductor.ACTIVE_IDLE_LIMIT - 1):
        harness.finish()
    harness.timers.clear()
    harness.call("review", task_id=task["id"], verdict="verified", basis="Evidence inspected")
    harness.finish()
    assert harness.call("role")["progress"]["status"] == "active"
    assert any(t.name == "conductor-continue" and t.delay == conductor.CONTINUE_DELAY
               for t in harness.timers)
    for _ in range(conductor.ACTIVE_IDLE_LIMIT):
        harness.timers.clear()
        harness.finish()
    assert harness.call("role")["progress"]["status"] == "idle_backoff"
    assert any(t.name == "conductor-continue" and t.delay == conductor.ACTIVE_IDLE_INTERVAL
               for t in harness.timers)
    second = task_record(1, resolved=False, review="pending")
    harness.store.data["tasks"][second["id"]] = second
    harness.timers.clear()
    harness.call("review", task_id=second["id"], verdict="verified", basis="Second inspected")
    harness.finish()
    resumed = harness.call("role")["progress"]
    assert resumed["status"] == "active"
    assert "next_continue_at" not in resumed
    assert any(t.name == "conductor-continue" and t.delay == conductor.CONTINUE_DELAY
               for t in harness.timers)


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


def test_store_reports_write_failure_and_recovers(conductor, tmp_path, monkeypatch):
    store = conductor.Store(tmp_path / 'state.json')
    original = type(store.path).replace
    monkeypatch.setattr(type(store.path), 'replace', lambda *a: (_ for _ in ()).throw(OSError('disk full')))
    assert store.save() is False
    assert 'disk full' in store.persistence_error
    monkeypatch.setattr(type(store.path), 'replace', original)
    assert store.save() is True
    assert store.persistence_error is None


def pending_task(harness, index=0):
    task = task_record(index, resolved=False, review=None)
    task.update(acked=False, notified=False, run_id=f'child-run-{index}', finished=1)
    harness.store.data['tasks'][task['id']] = task
    return task


def fire_next(harness):
    while harness.timers:
        timer = harness.timers.pop(0)
        if not getattr(timer, 'cancelled', False):
            timer.callback(*timer.args, **timer.kwargs)
            return
    pytest.fail('expected a scheduled delivery')


def test_delivery_retries_beyond_old_limit_and_acks_after_submit(harness, conductor, monkeypatch):
    task = pending_task(harness)
    calls = []
    clock = [100.0]
    monkeypatch.setattr(conductor.time, 'time', lambda: clock[0])

    def submit(text, **kwargs):
        assert not task['notified']
        calls.append(kwargs)
        if len(calls) <= conductor.WAKE_RETRIES + 2:
            return 503, {'error': 'temporarily unavailable'}
        return 202, {'run_id': 'delivery-run'}

    harness.services['web.host'].frontend.submit = submit
    harness.finish()
    for _ in range(conductor.WAKE_RETRIES + 3):
        clock[0] += 1000
        fire_next(harness)
    assert task['notified_run_id'] == 'delivery-run'
    assert task['acked'] and task['notified']
    assert len({call['request_id'] for call in calls}) == 1
    assert not harness.store.data['deliveries']


def test_delivery_coalesces_children_and_carries_metadata(harness):
    tasks = [pending_task(harness, i) for i in range(3)]
    calls = []
    harness.services['web.host'].frontend.submit = lambda text, **kw: (calls.append(kw) or (202, {'run_id': 'wake'}))
    harness.finish()
    harness.finish()
    fire_next(harness)
    assert len(calls) == 1
    assert len(calls[0]['metadata']['conductor']['tasks']) == 3
    assert all(t['notified_run_id'] == 'wake' for t in tasks)


def test_busy_parent_retains_delivery(harness):
    pending_task(harness)
    harness.services['runs'].active_for = lambda sid: {'id': 'busy'}
    harness.finish()
    fire_next(harness)
    assert harness.timers  # busy is a deferral, not loss of notification
    assert not harness.store.data['tasks']['task-0']['notified']


def test_store_recovers_unacknowledged_notification(conductor, tmp_path):
    path = tmp_path / 'state.json'
    store = conductor.Store(path)
    task = task_record(resolved=False, review=None)
    task.update(notified=False, acked=False)
    store.data['tasks'][task['id']] = task
    store.data['deliveries']['parent:wake'] = {'id': 'stable-request', 'parent': 'parent', 'kind': 'wake', 'attempts': 8}
    assert store.save()
    restored = conductor.Store(path)
    assert restored.data['deliveries']['parent:wake']['id'] == 'stable-request'
    assert not restored.data['tasks'][task['id']]['notified']


def test_startup_schedules_persisted_delivery_without_user_input(harness, conductor, monkeypatch):
    pending_task(harness)
    assert harness.store.save()
    restored = type(harness.store)(harness.store.path)
    for close in reversed(harness.cleanup):
        close()
    harness.cleanup.clear()
    harness.timers.clear()
    monkeypatch.setattr(conductor, "Store", lambda path: restored)
    calls = []
    harness.services["web.host"].frontend.submit = lambda text, **kw: (calls.append(kw) or (202, {"run_id": "recovered"}))
    conductor.apply(harness.ctx, {})
    fire_next(harness)
    assert len(calls) == 1
    assert restored.data["tasks"]["task-0"]["notified_run_id"] == "recovered"
    assert type(restored)(restored.path).data["tasks"]["task-0"]["acked"]


def test_startup_resumes_persisted_idle_backoff_timer(harness, conductor, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(conductor.time, "time", lambda: clock[0])
    for _ in range(conductor.ACTIVE_IDLE_LIMIT):
        harness.timers.clear()
        harness.finish()
    assert harness.store.data["progress"]["parent"]["status"] == "idle_backoff"
    assert harness.store.data["progress"]["parent"]["next_continue_at"] == 1000.0 + conductor.ACTIVE_IDLE_INTERVAL
    assert harness.store.save()
    restored = type(harness.store)(harness.store.path)
    for close in reversed(harness.cleanup):
        close()
    harness.cleanup.clear()
    harness.timers.clear()
    clock[0] = 1600.0
    monkeypatch.setattr(conductor, "Store", lambda path: restored)
    conductor.apply(harness.ctx, {})
    assert any(t.name == "conductor-continue" and t.delay == 1200.0 for t in harness.timers)


def test_archive_keeps_full_delivery_and_only_reduces_old_resolved_tasks(conductor, tmp_path):
    store = conductor.Store(tmp_path / "state.json")
    old = task_record()
    old.update(result="evidence " * 1000, objective="objective " * 1000, basis="verified " * 1000)
    current = task_record(1, stage=2)
    open_task = task_record(2, resolved=False)
    store.data["tasks"] = {t["id"]: t for t in (old, current, open_task)}
    store.data["progress"]["parent"] = {"stage": 2}
    expected = dict(old)
    assert store.save()
    assert old["archived"] and len(old["result"]) <= conductor.BRIEF_LIMIT
    assert not current.get("archived") and not open_task.get("archived")
    restored = conductor.Store(store.path)
    full = restored.full_task(restored.data["tasks"][old["id"]])
    for key in ("result", "objective", "basis", "child", "run_id"):
        assert full.get(key) == expected.get(key)
    snapshot = restored.data.copy()
    assert restored.save()
    assert conductor.Store(store.path).data == snapshot


def test_archive_write_failure_preserves_full_fields(conductor, tmp_path, monkeypatch):
    store = conductor.Store(tmp_path / "state.json")
    task = task_record()
    task["result"] = "evidence " * 1000
    store.data["tasks"][task["id"]] = task
    store.data["progress"]["parent"] = {"stage": 2}
    original = type(store.path).replace

    def replace(path, target):
        if target.parent.name.endswith("-archive"):
            raise OSError("archive unavailable")
        return original(path, target)

    monkeypatch.setattr(type(store.path), "replace", replace)
    assert store.save()
    assert "archive unavailable" in store.archive_error
    assert not task.get("archived") and task["result"] == "evidence " * 1000


def test_monitor_hint_uses_latest_user_request(conductor):
    assert conductor._reflect_requested([{"role": "user", "text": "Monitor the build"}])
    assert not conductor._reflect_requested([
        {"role": "user", "text": "Monitor the build"},
        {"role": "user", "text": "Explain this function"},
        {"role": "user", "text": "monitor", "source": conductor.SOURCE},
    ])


def test_role_exposes_monitor_hint(harness):
    harness.services["sessions"].get = lambda sid: {"messages": [{"role": "user", "text": "Watch this job"}]}
    assert harness.call("role")["reflect_requested"] is True


def test_failure_and_metrics_helpers(conductor):
    assert conductor._failure({"status": "aborted"}) == {"failure_kind": "user_aborted", "retryable": False}
    assert conductor._failure({"status": "interrupted"}) == {"failure_kind": "host_restart", "retryable": True}
    assert conductor._failure({"status": "error", "error": "unknown"})["failure_kind"] == "execution_error"
    assert conductor._failure({"status": "error", "error": "Run output could not be saved"}) == {
        "failure_kind": "save_failed", "retryable": True}
    metrics = conductor._task_metrics({"created": 10, "ended": 13}, {"turns": [
        {"usage": {"input": 12, "output": 3}}, {"usage": {"input": 4, "output": 2}},
    ]})
    assert metrics["seconds"] == 3 and metrics["turns"] == 2
    assert metrics["usage"]["input"] == 16 and metrics["usage"]["output"] == 5


def test_autopilot_on_normal_session_continues_pauses_and_yields_on_ask_user(conductor, harness):
    sid = "normal-chat"
    messages = []
    submitted = []
    harness.services["sessions"].get = lambda s: {"messages": messages if s == sid else []}
    harness.services["web.host"].frontend.submit = (
        lambda text, **kw: (submitted.append((text, kw)) or (202, {"run_id": f"auto-{len(submitted)}"}))
    )

    mode = harness.services["conductor.mode"]
    assert mode.set_active(sid, True) is True
    assert mode.active(sid) is True
    role = harness.services["conductor"]({"session_id": sid, "op": "role"})
    assert role["role"] == "none" and role["active"] is True

    updated = harness.services["conductor"]({
        "session_id": sid, "op": "checkpoint", "action": "update",
        "goal": "Ship autopilot", "next_step": "Patch worker tools",
    })
    assert updated["progress"]["goal"] == "Ship autopilot"
    for invalid in (
        {"action": "advance", "goal": "G", "handoff": "H", "next_step": "N"},
        {"action": "update", "status": "waiting_children"},
        {"action": "update", "status": "waiting_external", "reason": "r"},
    ):
        with pytest.raises((ValueError, RuntimeError)):
            harness.services["conductor"]({"session_id": sid, "op": "checkpoint", **invalid})

    # Real tool usage resets idle counter and schedules [Autopilot] continuation.
    msg1 = {"role": "assistant", "status": "done", "turns": [
        {"status": "done", "reply": "Step 1 done", "tools": [{"name": "code_run"}]},
    ]}
    harness.callbacks["run.finished"]({
        "session_id": sid, "run_id": "r1", "run": {"status": "done", "source": "web"}, "message": msg1,
    })
    fire_next(harness)
    harness.timers.clear()
    assert len(submitted) == 1
    text, kw = submitted.pop()
    assert text.startswith("[Autopilot]") and "Ship autopilot" in text
    assert kw["metadata"]["conductor"] == {"kind": "active", "mode": "autopilot"}

    # ask_user yields back to the user without scheduling an automatic continuation.
    msg2 = {"role": "assistant", "status": "done", "turns": [
        {"status": "done", "reply": "Need confirmation", "tools": [{"name": "ask_user"}]},
    ]}
    harness.callbacks["run.finished"]({
        "session_id": sid, "run_id": "r2", "run": {"status": "done", "source": conductor.SOURCE}, "message": msg2,
    })
    assert not harness.timers
    assert harness.services["conductor"]({"session_id": sid, "op": "role"})["progress"]["status"] == "blocked"

    # User answer unblocks; 3+ consecutive turns without real tool work back off to 30m indefinitely.
    reply_only = {"role": "assistant", "status": "done", "turns": [
        {"status": "done", "reply": "Just chatting", "tools": []},
    ]}
    harness.callbacks["run.finished"]({
        "session_id": sid, "run_id": "r-user", "run": {"status": "done", "source": "web"}, "message": reply_only,
    })
    assert harness.timers[-1].delay == conductor.CONTINUE_DELAY
    harness.timers.clear()
    for i in range(conductor.ACTIVE_IDLE_LIMIT + 2):
        harness.callbacks["run.finished"]({
            "session_id": sid, "run_id": f"idle-{i}",
            "run": {"status": "done", "source": conductor.SOURCE}, "message": reply_only,
        })
        expected = (conductor.CONTINUE_DELAY if i + 1 < conductor.ACTIVE_IDLE_LIMIT
                    else conductor.ACTIVE_IDLE_INTERVAL)
        assert harness.timers[-1].delay == expected
        if i + 1 >= conductor.ACTIVE_IDLE_LIMIT:
            fire_next(harness)
            text, _ = submitted.pop()
            assert "30 minutes" in text
        harness.timers.clear()
    backoff = harness.services["conductor"]({"session_id": sid, "op": "role"})["progress"]
    assert backoff["status"] == "idle_backoff"
    assert "no progress" in backoff["reason"]
    assert backoff["next_continue_at"] > 0

    # Real tool execution immediately exits 30m backoff back to normal 1s continuation.
    with_tool = {"role": "assistant", "status": "done", "turns": [
        {"status": "done", "reply": "Made progress", "tools": [{"name": "code_run", "ok": True}]},
    ]}
    harness.callbacks["run.finished"]({
        "session_id": sid, "run_id": "r-progressed",
        "run": {"status": "done", "source": conductor.SOURCE}, "message": with_tool,
    })
    recovered = harness.services["conductor"]({"session_id": sid, "op": "role"})["progress"]
    assert recovered["status"] == "active"
    assert "next_continue_at" not in recovered
    assert harness.timers[-1].delay == conductor.CONTINUE_DELAY
    harness.timers.clear()

    # Manual "Continue now" (set_active True while in idle_backoff) immediately resumes and schedules.
    for i in range(conductor.ACTIVE_IDLE_LIMIT):
        harness.callbacks["run.finished"]({
            "session_id": sid, "run_id": f"idle-again-{i}",
            "run": {"status": "done", "source": conductor.SOURCE}, "message": reply_only,
        })
        harness.timers.clear()
    assert harness.services["conductor"]({"session_id": sid, "op": "role"})["progress"]["status"] == "idle_backoff"
    assert mode.set_active(sid, True) is True
    resumed = harness.services["conductor"]({"session_id": sid, "op": "role"})["progress"]
    assert resumed["status"] == "active"
    assert "next_continue_at" not in resumed
    assert harness.timers[-1].delay == conductor.CONTINUE_DELAY
    harness.timers.clear()

    # A failed model call backs off at once instead of prompting again a second later.
    harness.callbacks["run.finished"]({
        "session_id": sid, "run_id": "r-llm-down", "message": reply_only,
        "run": {"status": "error", "source": conductor.SOURCE,
                "error": "The model call failed; the run stopped. !!!Error: HTTP 503"},
    })
    assert harness.timers[-1].delay == 60
    down = harness.services["conductor"]({"session_id": sid, "op": "role"})["progress"]
    assert down["status"] == "idle_backoff"
    assert "model unavailable" in down["reason"]
    harness.timers.clear()

    def llm_down(run_id):
        harness.callbacks["run.finished"]({
            "session_id": sid, "run_id": run_id, "message": reply_only,
            "run": {"status": "error", "source": conductor.SOURCE,
                    "error": "The model call failed; the run stopped. !!!Error: HTTP 503"},
        })
        delay = harness.timers[-1].delay
        harness.timers.clear()
        return delay

    # Repeated failures wait 1 min twice, then 5, 15 and finally 30 minutes each time.
    assert [llm_down(f"r-llm-down-{i}") for i in range(5)] == [
        60, 300, 900, conductor.ACTIVE_IDLE_INTERVAL, conductor.ACTIVE_IDLE_INTERVAL]

    # A run that works again starts the ladder over.
    harness.callbacks["run.finished"]({
        "session_id": sid, "run_id": "r-llm-back", "run": {"status": "done", "source": conductor.SOURCE},
        "message": msg1,
    })
    assert harness.timers[-1].delay == conductor.CONTINUE_DELAY
    back = harness.services["conductor"]({"session_id": sid, "op": "role"})["progress"]
    assert back["status"] == "active" and "next_continue_at" not in back
    harness.timers.clear()
    assert llm_down("r-llm-down-again") == 60

    # A run whose output could not be saved is retried on the same ladder.
    harness.callbacks["run.finished"]({
        "session_id": sid, "run_id": "r-unsaved", "message": reply_only,
        "run": {"status": "error", "source": conductor.SOURCE, "error": "Run output could not be saved"},
    })
    assert harness.timers[-1].delay == 60
    unsaved = harness.services["conductor"]({"session_id": sid, "op": "role"})["progress"]
    assert unsaved["status"] == "idle_backoff"
    assert unsaved["reason"].startswith("run output not saved")
    harness.timers.clear()

    # Any other failure is still left to the user.
    harness.callbacks["run.finished"]({
        "session_id": sid, "run_id": "r-broken", "message": reply_only,
        "run": {"status": "error", "source": conductor.SOURCE, "error": "Worker failed (ValueError)"},
    })
    assert not harness.timers

    # finish(done) stops until user input.
    harness.services["conductor"]({"session_id": sid, "op": "finish", "status": "done", "summary": "Completed"})
    harness.callbacks["run.finished"]({
        "session_id": sid, "run_id": "r-done", "run": {"status": "done", "source": conductor.SOURCE},
    })
    assert not harness.timers

    # Worker child sessions cannot enable autopilot.
    harness.store.data["tasks"]["t-child"] = task_record(0, resolved=False)
    with pytest.raises((ValueError, RuntimeError)):
        mode.set_active("child-0", True)


def test_worker_exposes_autopilot_tools_without_conductor_mode(harness, monkeypatch):
    import importlib.util
    import sys
    from pathlib import Path
    from types import SimpleNamespace

    sid = "normal-autopilot"
    harness.services["conductor.mode"].set_active(sid, True)
    harness.services["conductor"]({
        "session_id": sid, "op": "checkpoint", "action": "update",
        "goal": "Continuous goal", "next_step": "Verify tools",
    })

    worker_path = Path(importlib.import_module("ga_harness.plugins.conductor.main").__file__).resolve().parent.parent / "conductor-worker" / "main.py"
    spec = importlib.util.spec_from_file_location("test_conductor_worker_mod", worker_path)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)

    monkeypatch.setitem(sys.modules, "agent_loop", SimpleNamespace(
        StepOutcome=lambda msg, next_prompt=None, should_exit=False: SimpleNamespace(
            msg=msg, next_prompt=next_prompt, should_exit=should_exit),
    ))
    tools = {}
    disabled = []
    hooks = {}
    host = SimpleNamespace(
        session_id=sid,
        call=lambda name, payload, timeout=None: harness.services[name](payload),
    )
    ga_tools = SimpleNamespace(
        names=lambda: list(tools) + ["code_run", "ask_user"],
        register=lambda schema, fn: tools.__setitem__(schema["function"]["name"], fn) or (lambda: None),
        disable=lambda name: disabled.append(name) or (lambda: None),
    )
    services = {"run.host": host, "ga.tools": ga_tools}
    wctx = SimpleNamespace(
        has=services.__contains__,
        get=services.get,
        on=hooks.__setitem__,
        scope=SimpleNamespace(add=lambda fn: None),
    )
    worker.apply(wctx, {})
    rendered = hooks["ga.system_prompt"]("Base prompt", lambda t: t)

    assert set(tools) == {"autopilot_checkpoint", "autopilot_finish"}
    assert disabled == []
    assert "### Autopilot mode" in rendered
    assert "### Saved autopilot checkpoint" in rendered
    assert "Continuous goal" in rendered
    assert "### Conductor mode" not in rendered
    outcome = tools["autopilot_finish"](None, {"status": "done", "summary": "All done"}, None)
    assert json.loads(outcome.msg)["finished"] == "done"
