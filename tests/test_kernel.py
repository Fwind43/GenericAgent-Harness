import pytest
from ga_harness.kernel import EventBus, Plugin, Runtime, Scope


def test_scope_disposes_in_reverse_once():
    s, out = Scope(), []
    s.add(lambda: out.append(1)); d2 = s.add(lambda: out.append(2)); s.add(lambda: out.append(3))
    d2(); d2()
    s.dispose()
    assert out == [2, 3, 1] and len(s) == 0


def test_event_modes():
    b = EventBus()
    b.on("x", lambda v: v + 1); b.on("x", lambda v: None, priority=5)
    assert b.serial("x", 1) == [None, 2]
    assert b.bail("x", 1) == 2
    assert sorted(map(str, b.parallel("x", 1))) == ["2", "None"]
    b.on("e", lambda: 1 / 0)
    b.emit("e")  # errors swallowed


def test_waterfall_middleware_order_and_short_circuit():
    b, trace = EventBus(), []
    def outer(v, nxt): trace.append("outer"); return nxt(v + "a") + "!"
    def inner(v, nxt): trace.append("inner"); return nxt(v + "b")
    b.on("w", inner); b.on("w", outer, priority=10)
    assert b.waterfall("w", "", lambda v: v + "core") == "abcore!"
    assert trace == ["outer", "inner"]
    b.on("w", lambda v, nxt: "denied", priority=100)
    assert b.waterfall("w", "", lambda v: "core") == "denied"


def test_disposer_removes_listener():
    b = EventBus(); off = b.on("x", lambda: 1)
    off(); assert b.serial("x") == []


def test_inject_gates_activation_and_suspends_on_withdraw():
    rt, log = Runtime(), []

    def consumer(ctx, cfg):
        log.append("up:" + ctx.greeter())
        ctx.on("ping", lambda: log.append("pong"))
        return lambda: log.append("down")

    def provider(ctx, cfg):
        ctx.provide("greeter", lambda: cfg["word"])

    rt.add(Plugin("consumer", consumer, inject=["greeter"]))
    assert rt.status()["consumer"] == {"state": "pending", "missing": ["greeter"], "error": None}
    rt.add(Plugin("provider", provider, provides=["greeter"]), {"word": "hi"})
    assert log == ["up:hi"]
    rt.ctx.emit("ping"); assert log[-1] == "pong"

    rt.remove("provider")
    assert log[-1] == "down" and rt.status()["consumer"]["state"] == "pending"
    rt.ctx.emit("ping"); assert log[-1] == "down"  # listener gone

    rt.add(Plugin("provider", provider), {"word": "again"})
    assert log[-1] == "up:again"


def test_optional_inject_and_apply_error():
    rt = Runtime()
    rt.add(Plugin("opt", lambda ctx, c: ctx.provide("x", 1), inject=["nope?"]))
    assert rt.ctx.x == 1
    def bad(ctx, c):
        ctx.provide("y", 2); raise ValueError("boom")
    rt.add(Plugin("bad", bad))
    assert rt.status()["bad"]["state"] == "error" and not rt.ctx.has("y")


def test_duplicate_capability_rejected_and_reload():
    rt = Runtime()
    rt.add(Plugin("a", lambda ctx, c: ctx.provide("k", c["v"])), {"v": 1})
    with pytest.raises(KeyError):
        rt.ctx.child("other").provide("k", 2)
    rt.reload("a", config={"v": 3})
    assert rt.ctx.k == 3


def test_ctx_attribute_errors():
    rt = Runtime()
    with pytest.raises(AttributeError):
        rt.ctx.missing
    with pytest.raises(AttributeError):
        rt.ctx.foo = 1
