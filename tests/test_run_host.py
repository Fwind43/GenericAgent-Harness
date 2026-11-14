"""Worker-side host channel (``run.host``); no worker process is spawned."""
import threading

import pytest

from ga_harness.worker import RpcError, WorkerHost


def make_host():
    sent = []
    host = WorkerHost(lambda kind, **data: sent.append(dict(kind=kind, **data)), "r1", "s1")
    return host, sent


def test_call_returns_host_result():
    host, sent = make_host()

    def answer():
        while not sent:
            pass
        host._resolve({"kind": "rpc_result", "id": sent[0]["id"], "result": {"ok": 1}})
    threading.Thread(target=answer, daemon=True).start()
    assert host.call("svc", {"x": 1}, timeout=5) == {"ok": 1}
    assert sent[0]["kind"] == "rpc" and sent[0]["service"] == "svc" and sent[0]["body"] == {"x": 1}
    host._close()


def test_call_error_timeout_and_cancel():
    host, sent = make_host()
    threading.Timer(0.05, lambda: host._resolve({"id": sent[0]["id"], "error": "nope"})).start()
    with pytest.raises(RpcError, match="nope"):
        host.call("svc", timeout=5)
    with pytest.raises(RpcError):
        host.call("svc", timeout=0.05)
    threading.Timer(0.05, host._close).start()
    with pytest.raises(RpcError, match="cancelled"):
        host.call("svc", timeout=5)
    with pytest.raises(RpcError):
        host.call("svc", timeout=5)


def test_emit_prefixes_plugin_namespace():
    host, sent = make_host()
    host.emit("team.message", {"a": 1})
    host.emit("plugin.x")
    assert [m["name"] for m in sent] == ["plugin.team.message", "plugin.x"]
    host._close()


def test_push_dispatch_and_dispose():
    host, _ = make_host()
    got, done = [], threading.Event()
    off = host.on_push("inbox", lambda data: got.append(("inbox", data)))
    host.on_push("*", lambda topic, data: (got.append(("*", topic, data)), done.set()))
    host._push({"topic": "inbox", "data": 1})
    assert done.wait(2)
    off()
    done.clear()
    host._push({"topic": "inbox", "data": 2})
    assert done.wait(2)
    assert got == [("inbox", 1), ("*", "inbox", 1), ("*", "inbox", 2)]
    host._close()


def test_llm_failed_recognises_ga_error_markers_only():
    from ga_harness.worker import _llm_failed

    assert _llm_failed("!!!Error: HTTP 503 Service Unavailable")
    assert _llm_failed("partial answer\n[!!! \u6d41\u5f02\u5e38\u4e2d\u65ad: ReadTimeout]")
    assert not _llm_failed("")
    assert not _llm_failed("All done, nothing failed.")
    # A long normal reply that merely quotes the marker early on is not a failure.
    assert not _llm_failed("The log said [!!! \u6d41\u5f02\u5e38\u4e2d\u65ad once. " + "x" * 500)
