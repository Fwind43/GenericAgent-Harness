"""Swarm mode contracts with inert services (no live model, no real runs)."""
import importlib
import importlib.util
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest


class FakeCtx:
    def __init__(self, services):
        self.services = services
        self.hooks = {}
        self.closers = []
        self.provided = {}
        self.scope = SimpleNamespace(add=self.closers.append)

    def get(self, name):
        return self.services[name]

    def has(self, name):
        return name in self.services

    def on(self, name, fn):
        self.hooks[name] = fn

    def provide(self, name, value):
        self.provided[name] = value

    def close(self):
        for fn in reversed(self.closers):
            if callable(fn):
                fn()


class World:
    """Fake runs/sessions/web.host shared across plugin (re)loads."""

    def __init__(self, tmp_path):
        self.tmp_path = tmp_path
        self.started = []  # (session_id, text, source, run_id)
        self.records = {}
        self.requests = {}
        self.cancelled = []
        self.sessions = {"coord": {"id": "coord", "workspace": None}}
        self.remembered = {}
        self.rpc = {}
        self.routes = {}
        self.worker_plugins = []
        self._n = 0

    def services(self):
        def start(text, session_id=None, source=None, timeout=None, request_id=None):
            key = (session_id, source, request_id)
            if request_id is not None and key in self.requests:
                return dict(self.records[self.requests[key]])
            self._n += 1
            rid = f"run{self._n}"
            self.records[rid] = {"id": rid, "session_id": session_id, "source": source, "status": "running"}
            if request_id is not None:
                self.requests[key] = rid
            self.started.append((session_id, text, source, rid))
            return dict(self.records[rid])

        def active_for(sid):
            return next((r for r in self.records.values() if r["session_id"] == sid
                         and r["status"] in ("running", "cancelling")), None)

        def cancel(rid):
            self.records[rid]["status"] = "cancelling"
            self.cancelled.append(rid)

        def create(parent_id=None, title=None, workspace=None):
            self._n += 1
            sid = f"s{self._n}"
            self.sessions[sid] = {"id": sid, "parent_id": parent_id, "title": title, "workspace": workspace}
            return self.sessions[sid]

        def register(name, script=None, style=None, order=0, routes=None):
            self.routes.update(routes or {})
            return lambda: None

        runs = SimpleNamespace(
            start=start, active_for=active_for, get=lambda rid: dict(self.records[rid]),
            cancel=cancel,
            register_rpc=lambda name, fn: self.rpc.__setitem__(name, fn) or (lambda: None),
            register_worker_plugin=lambda name: self.worker_plugins.append(name) or (lambda: None),
        )
        sessions = SimpleNamespace(
            path=str(self.tmp_path / "sessions.db"),
            get=lambda sid, light=False: self.sessions.get(sid),
            create=create,
            remember_for=lambda sid, **values: self.remembered.setdefault(sid, {}).update(values),
        )
        frontend = SimpleNamespace(broadcast=lambda *a, **k: None, snapshot=lambda: {})
        host = SimpleNamespace(frontend=frontend, register=register)
        models = SimpleNamespace()
        return {"web.host": host, "runs": runs, "sessions": sessions, "models": models}

    def route(self, name, body):
        return self.routes[("POST", name)]({"body": body})

    def call(self, body, session_id=None, run_id=None):
        call = SimpleNamespace(session_id=session_id, run_id=run_id)
        return self.rpc["swarm"](dict(body), call)


@pytest.fixture
def swarm_mod():
    return importlib.import_module("ga_harness.plugins.swarm.main")


@pytest.fixture
def world(tmp_path):
    return World(tmp_path)


@pytest.fixture
def load(swarm_mod, world):
    ctxs = []

    def _load(**config):
        config.setdefault("idle_wake", 3600)
        ctx = FakeCtx(world.services())
        swarm_mod.apply(ctx, config)
        ctxs.append(ctx)
        return ctx

    yield _load
    for ctx in ctxs:
        ctx.close()


def wait_for(cond, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return cond()


def finish_run(ctx, world, sid, run_id, status="done", error=None):
    record = world.records[run_id]
    record.update(status=status, error=error)
    ctx.hooks["run.finished"]({"session_id": sid, "run_id": run_id, "run": dict(record)})


def started_for(world, sid):
    return [s for s in world.started if s[0] == sid]


def test_registration_and_toggle(load, world):
    ctx = load()
    assert "swarm" in world.rpc
    assert world.worker_plugins == ["swarm-worker", "ga-steer"]  # ga-steer: mentions steered into running turns
    assert {"toggle", "post", "remove", "cancel", "resume", "board"} <= {k[1] for k in world.routes}
    mode = ctx.provided["swarm.mode"]
    assert mode.enabled("coord") is False
    assert world.call({"op": "role"}, session_id="coord") == {"role": "none"}
    status, body = world.route("toggle", {"session_id": "coord", "enabled": True})
    assert status == 200 and body["enabled"] is True
    assert mode.enabled("coord") is True
    assert world.call({"op": "role"}, session_id="coord")["role"] == "coordinator"


def test_mesh_mentions_wake_members_and_coordinator(load, world):
    ctx = load()
    world.route("toggle", {"session_id": "coord", "enabled": True})
    alice = world.call({"op": "add", "name": "alice", "role": "Researcher", "brief": "Dig"},
                       session_id="coord")["member"]
    bob = world.call({"op": "add", "name": "Bob", "role": "Writer", "groups": ["docs"]},
                     session_id="coord")["member"]
    a_sid, b_sid = alice["session"], bob["session"]
    assert world.sessions[a_sid]["parent_id"] == "coord"
    assert bob["name"] == "bob"

    role = world.call({"op": "role"}, session_id=b_sid)
    assert role["role"] == "member" and role["name"] == "bob" and role["groups"] == ["docs"]

    # coordinator mentions alice -> only alice is started, with source "swarm"
    out = world.call({"op": "post", "text": "@alice please research X"}, session_id="coord")
    assert out["woken"] == ["alice"]
    assert wait_for(lambda: started_for(world, a_sid))
    sid, text, source, a_run = started_for(world, a_sid)[0]
    assert source == "swarm" and "research X" in text
    assert not started_for(world, b_sid)

    # mesh: alice talks to bob directly (via the @docs group), not via the coordinator
    out = world.call({"op": "post", "text": "@docs draft from my notes"}, session_id=a_sid)
    assert "bob" in out["woken"]
    assert wait_for(lambda: started_for(world, b_sid))

    # read returns unseen posts and advances the cursor
    first = world.call({"op": "read"}, session_id=b_sid)
    again = world.call({"op": "read"}, session_id=b_sid)
    assert any("draft from my notes" in p["text"] for p in json.loads(json.dumps(first))["posts"])
    assert again["posts"] == []

    # a finished run marks the member idle again
    def status(name):
        return next(m["status"] for m in world.call({"op": "members"}, session_id="coord")["members"]
                    if m["name"] == name)
    assert status("alice") == "running"
    finish_run(ctx, world, a_sid, a_run)
    assert status("alice") == "idle"


def test_validation_and_coordinator_only_ops(load, world):
    load()
    world.route("toggle", {"session_id": "coord", "enabled": True})
    with pytest.raises(ValueError):
        world.call({"op": "add", "name": "all", "role": "x"}, session_id="coord")
    with pytest.raises(ValueError):
        world.call({"op": "add", "name": "9bad", "role": "x"}, session_id="coord")
    m = world.call({"op": "add", "name": "alice", "role": "R"}, session_id="coord")["member"]
    with pytest.raises(ValueError):
        world.call({"op": "add", "name": "alice", "role": "R"}, session_id="coord")
    # the RPC binds session_id to the caller: a member cannot pose as the coordinator
    with pytest.raises(RuntimeError):
        world.call({"op": "add", "name": "eve", "role": "R", "session_id": "coord"},
                   session_id=m["session"])
    with pytest.raises(RuntimeError):
        world.call({"op": "post", "text": "hi"}, session_id="stranger")
    # a member session cannot start its own swarm
    status, _ = world.route("toggle", {"session_id": m["session"], "enabled": True})
    assert status == 409


def test_per_swarm_concurrency_limit(load, world):
    ctx = load(max_concurrent=1)
    world.route("toggle", {"session_id": "coord", "enabled": True})
    a = world.call({"op": "add", "name": "a", "role": "R"}, session_id="coord")["member"]["session"]
    b = world.call({"op": "add", "name": "b", "role": "R"}, session_id="coord")["member"]["session"]
    world.call({"op": "post", "text": "@a @b go"}, session_id="coord")
    assert wait_for(lambda: len(world.started) == 1)
    time.sleep(0.2)
    assert len(world.started) == 1
    first_sid, _, _, first_run = world.started[0]
    other = b if first_sid == a else a
    finish_run(ctx, world, first_sid, first_run)
    assert wait_for(lambda: started_for(world, other))


def test_handoff_holds_mentions_until_user_reply(load, world):
    ctx = load()
    world.route("toggle", {"session_id": "coord", "enabled": True})
    member = world.call({"op": "add", "name": "a", "role": "R"}, session_id="coord")["member"]
    handoff = {"op": "await_user", "summary": "Draft ready for review"}
    with pytest.raises(RuntimeError, match="only the coordinator"):
        world.call(handoff, session_id=member["session"])
    world.call(handoff, session_id="coord")
    world.call(handoff, session_id="coord")
    posts = world.call({"op": "read", "since": 0}, session_id="coord")["posts"]
    assert [p["text"] for p in posts if p["kind"] == "handoff"] == [handoff["summary"]]

    world.call({"op": "post", "text": "@coordinator late report"}, session_id=member["session"])
    for sid, source in [("coord", "swarm"), (member["session"], "user")]:
        ctx.hooks["run.started"]({"session_id": sid, "run": {"source": source}})
    assert ctx.provided["swarm.mode"].enabled("coord")
    assert world.call({"op": "role"}, session_id="coord")["awaiting_user"]
    assert not started_for(world, "coord")

    status, body = world.route("post", {"session_id": "coord", "text": "Please revise"})
    assert status == 200 and body["post"]["mentions"] == ["coordinator"]
    assert not world.call({"op": "role"}, session_id="coord")["awaiting_user"]
    wake, = started_for(world, "coord")
    assert "Please revise" in wake[1] and "late report" in wake[1]


def test_plugin_reload_preserves_live_member_and_handoff(load, world, tmp_path):
    ctx = load()
    world.route("toggle", {"session_id": "coord", "enabled": True})
    a = world.call({"op": "add", "name": "a", "role": "R"}, session_id="coord")["member"]["session"]
    world.call({"op": "post", "text": "@a go"}, session_id="coord")
    assert wait_for(lambda: started_for(world, a))
    world.call({"op": "await_user", "summary": "Ready for review"}, session_id="coord")
    ctx.close()
    assert (tmp_path / "swarm.json").is_file()

    ctx2 = load()
    assert ctx2.provided["swarm.mode"].enabled("coord") is True
    members = world.call({"op": "members"}, session_id="coord")["members"]
    assert [m["status"] for m in members if m["name"] == "a"] == ["running"]
    assert len(started_for(world, a)) == 1
    assert world.call({"op": "role"}, session_id=a)["role"] == "member"
    assert world.call({"op": "role"}, session_id="coord")["awaiting_user"]
    ctx2.hooks["run.started"]({"session_id": "coord", "run": {"source": "user"}})
    assert not world.call({"op": "role"}, session_id="coord")["awaiting_user"]
    assert not started_for(world, "coord")  # the chat turn already carries the reply


def test_user_turn_in_member_session_leaves_silent_board_note(load, world):
    ctx = load()
    world.route("toggle", {"session_id": "coord", "enabled": True})
    a = world.call({"op": "add", "name": "a", "role": "R"}, session_id="coord")["member"]["session"]
    ctx.hooks["run.started"]({"session_id": a, "run": {"source": "user", "task": "  use   tabs\nnot spaces "}})
    ctx.hooks["run.started"]({"session_id": a, "run": {"source": "swarm", "task": "board wake"}})
    ctx.hooks["run.started"]({"session_id": "coord", "run": {"source": "user", "task": "hello"}})
    posts = world.call({"op": "read", "since": 0}, session_id="coord")["posts"]
    direct = [p for p in posts if p["kind"] == "direct"]
    assert [(p["author"], p["text"], p["mentions"]) for p in direct] == [
        ("user", "(private to a) use tabs not spaces", [])]
    assert not started_for(world, a) and not started_for(world, "coord")


def start_member_assignment(world):
    world.route("toggle", {"session_id": "coord", "enabled": True})
    sid = world.call({"op": "add", "name": "a", "role": "Reviewer"}, session_id="coord")["member"]["session"]
    world.call({"op": "post", "text": "@a review the first draft"}, session_id="coord")
    assert wait_for(lambda: started_for(world, sid))
    return sid, started_for(world, sid)[0][3]


def test_crashed_member_resumes_before_queued_mention(load, world, swarm_mod, monkeypatch):
    monkeypatch.setattr(swarm_mod, "RECOVERY_DELAYS", (0, 0, 0))
    ctx = load()
    sid, original = start_member_assignment(world)
    world.call({"op": "post", "text": "@a check the appendix next"}, session_id="coord")
    world.call({"op": "read"}, session_id=sid)  # reading advances the board cursor
    finish_run(ctx, world, sid, original, "error", "Worker exited before completion")

    assert wait_for(lambda: len(started_for(world, sid)) == 2)
    _, prompt, _, resumed = started_for(world, sid)[1]
    assert resumed != original and "review the first draft" in prompt and "Resume" in prompt
    assert "appendix" not in prompt
    finish_run(ctx, world, sid, resumed)
    assert wait_for(lambda: len(started_for(world, sid)) == 3)
    followup = started_for(world, sid)[2][1]
    assert "check the appendix next" in followup and "first draft" not in followup
    assert not started_for(world, "coord")


def test_reload_recovers_interruption_missed_by_hook(load, world, swarm_mod, monkeypatch):
    monkeypatch.setattr(swarm_mod, "RECOVERY_DELAYS", (0, 0, 0))
    ctx = load()
    sid, original = start_member_assignment(world)
    ctx.close()
    world.records[original].update(status="interrupted", error="Service interrupted before completion")
    load()
    assert wait_for(lambda: len(started_for(world, sid)) == 2)
    _, prompt, _, resumed = started_for(world, sid)[1]
    assert resumed != original and "review the first draft" in prompt and "Resume" in prompt
    assert set(world.sessions) == {"coord", sid}


def test_stop_during_recovery_survives_reload(load, world, swarm_mod, monkeypatch):
    monkeypatch.setattr(swarm_mod, "RECOVERY_DELAYS", (3600,))
    ctx = load()
    sid, original = start_member_assignment(world)
    finish_run(ctx, world, sid, original, "interrupted")
    member, = world.call({"op": "members"}, session_id="coord")["members"]
    assert member["status"] == "recovering" and member["recovery"]["attempt"] == 1
    status, _ = world.route("cancel", {"session_id": "coord", "name": "a"})
    assert status == 200
    ctx.close()
    load()
    member, = world.call({"op": "members"}, session_id="coord")["members"]
    assert member["status"] == "idle" and "recovery" not in member
    assert len(started_for(world, sid)) == 1


def test_recovery_budget_is_per_assignment(load, world, swarm_mod, monkeypatch):
    retries = len(swarm_mod.RECOVERY_DELAYS)
    monkeypatch.setattr(swarm_mod, "RECOVERY_DELAYS", (0,) * retries)
    ctx = load()
    sid, run_id = start_member_assignment(world)
    for attempt in range(retries):
        finish_run(ctx, world, sid, run_id, "error", "Worker exited before completion")
        assert wait_for(lambda: len(started_for(world, sid)) == attempt + 2)
        run_id = started_for(world, sid)[-1][3]
    finish_run(ctx, world, sid, run_id, "error", "Worker exited before completion")
    member, = world.call({"op": "members"}, session_id="coord")["members"]
    assert member["status"] == "error" and "recovery" not in member
    world.call({"op": "post", "text": "@a review a new draft"}, session_id="coord")
    assert wait_for(lambda: len(started_for(world, sid)) == retries + 2)
    assert "review a new draft" in started_for(world, sid)[-1][1]


def test_snapshot_hook_exposes_swarm(load, world):
    ctx = load()
    world.route("toggle", {"session_id": "coord", "enabled": True})
    world.call({"op": "add", "name": "a", "role": "R"}, session_id="coord")
    data = {}
    out = ctx.hooks["web.snapshot"](data, lambda d: d)
    snap = out if isinstance(out, dict) else data
    assert "swarm" in json.dumps(snap)


@pytest.fixture
def worker_mod():
    path = Path(importlib.import_module("ga_harness.plugins.swarm.main").__file__).resolve().parent.parent / "swarm-worker" / "main.py"
    spec = importlib.util.spec_from_file_location("test_swarm_worker_mod", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _worker(worker_mod, world, sid, monkeypatch):
    monkeypatch.setitem(sys.modules, "agent_loop", SimpleNamespace(
        StepOutcome=lambda msg, next_prompt=None, should_exit=False: SimpleNamespace(
            msg=msg, next_prompt=next_prompt, should_exit=should_exit)))
    tools = {}
    host = SimpleNamespace(session_id=sid,
                           call=lambda name, payload, timeout=None: world.call(payload, session_id=sid))
    ga_tools = SimpleNamespace(
        names=lambda: list(tools) + ["code_run"],
        register=lambda schema, fn: tools.__setitem__(schema["function"]["name"], fn) or (lambda: None))
    ctx = FakeCtx({"run.host": host, "ga.tools": ga_tools})
    worker_mod.apply(ctx, {})
    prompt = ctx.hooks["ga.system_prompt"]("BASE", lambda t: t)
    return tools, prompt


def test_worker_tools_by_role(load, world, worker_mod, monkeypatch):
    load()
    tools, prompt = _worker(worker_mod, world, "nobody", monkeypatch)
    assert tools == {} and prompt == "BASE"

    world.route("toggle", {"session_id": "coord", "enabled": True})
    tools, prompt = _worker(worker_mod, world, "coord", monkeypatch)
    assert {"board_post", "board_read", "swarm_add_member", "swarm_await_user"} <= set(tools)
    assert "swarm_finish" not in tools
    out = tools["swarm_add_member"](None, {"name": "alice", "role": "Researcher", "brief": "B1"}, None)
    member = json.loads(out.msg)["member"]

    tools, prompt = _worker(worker_mod, world, member["session"], monkeypatch)
    assert "board_post" in tools
    assert {"swarm_add_member", "swarm_await_user", "swarm_finish"}.isdisjoint(tools)
    assert "alice" in prompt and "B1" in prompt
    out = tools["board_post"](None, {"text": "@coordinator hello"}, None)
    assert json.loads(out.msg)["woken"] == ["coordinator"]
    # errors come back as tool text rather than raising
    out = tools["board_post"](None, {"text": ""}, None)
    assert out.msg.startswith("[Error]")


def test_worker_end_turn_tool_stops_run(load, world, worker_mod, monkeypatch):
    load()
    world.route("toggle", {"session_id": "coord", "enabled": True})
    tools, prompt = _worker(worker_mod, world, "coord", monkeypatch)
    assert "swarm_end_turn" in tools and "swarm_end_turn" in prompt
    assert "code_run" in prompt  # the prompt forbids waiting for the team in code_run
    out = tools["swarm_end_turn"](None, {"note": "waiting for alice"}, None)
    # no next_prompt -> GA's agent loop ends the run (CURRENT_TASK_DONE)
    assert out.next_prompt is None and not out.should_exit
    assert "waiting for alice" in out.msg
    member = json.loads(tools["swarm_add_member"](None, {"name": "alice", "role": "R"}, None).msg)["member"]
    tools, prompt = _worker(worker_mod, world, member["session"], monkeypatch)
    assert "swarm_end_turn" in tools and "swarm_end_turn" in prompt
    assert tools["swarm_end_turn"](None, {}, None).next_prompt is None

def test_worker_end_turn_answers_user_first(load, world, worker_mod, monkeypatch):
    load()
    world.route("toggle", {"session_id": "coord", "enabled": True})
    monkeypatch.setitem(sys.modules, "agent_loop", SimpleNamespace(
        StepOutcome=lambda msg, next_prompt=None, should_exit=False: SimpleNamespace(
            msg=msg, next_prompt=next_prompt, should_exit=should_exit)))
    tools = {}
    host = SimpleNamespace(session_id="coord",
                           call=lambda name, payload, timeout=None: world.call(payload, session_id="coord"))
    ga_tools = SimpleNamespace(
        names=lambda: list(tools),
        register=lambda schema, fn: tools.__setitem__(schema["function"]["name"], fn) or (lambda: None))
    ctx = FakeCtx({"run.host": host, "ga.tools": ga_tools})
    worker_mod.apply(ctx, {})
    start = lambda text: ctx.hooks["ga.agent_before"]({"user_input": text}, lambda g: g)
    reply = lambda text: SimpleNamespace(content=text)
    end = lambda resp: tools["swarm_end_turn"](None, {}, resp)

    # user asks for progress, model answers only with the tool or only inside hidden
    # tags -> pushed back twice, then the third call always ends
    start("what is the progress?")
    out = end(reply("<summary>checking</summary>"))
    assert out.next_prompt and "Write the reply to the user" in out.next_prompt
    assert "<thinking>" in out.next_prompt
    assert end(reply("<thinking>Alice is done.</thinking>")).next_prompt
    assert end(reply("")).next_prompt is None

    # visible text in the same response is enough
    start("status?")
    assert end(reply("Alice is done; Bob is testing.")).next_prompt is None

    # text from an earlier step of the turn counts as a reply
    start("status?")
    ctx.hooks["ga.llm_after"]({"response": reply("Two of three tasks done.")}, lambda g: g)
    assert end(reply("")).next_prompt is None

    # host wake-ups may end silently
    start("[Swarm] You were mentioned on the board.\n#3 @alice: done")
    assert end(reply("")).next_prompt is None
