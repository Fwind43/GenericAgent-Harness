import json
import threading
import time
import urllib.error
import urllib.request

from tests.test_frontend import _mount_with


class WebAgent:
    """Echo agent; task "wait" blocks until abort()."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.calls = []
        self.aborts = 0
        self.release = threading.Event()

    def run(self, task, timeout=None):
        self.calls.append(task)
        self.ctx.emit("agent.chunk", "<b>re:</b>")
        if task == "wait":
            self.release.wait(5)
            return "x"
        if task == "boom":
            raise RuntimeError("kaput")
        if task == "tool":
            e = self.ctx.emit
            e("run.start", {})
            e("turn.start", {"turn": 1})
            e("assistant.text", {"turn": 1, "text": "<summary>calc</summary>go", "reply": "go", "summary": "calc"})
            e("tool.call", {"id": "1.0", "turn": 1, "index": 0, "name": "code_run", "args": {"script": "1+1"}})
            e("tool.result", {"id": "1.0", "turn": 1, "index": 0, "name": "code_run", "ok": True,
                              "data": {"stdout": "2"}, "seconds": 0.5})
            e("turn.end", {"turn": 1})
            e("turn.start", {"turn": 2})
            e("assistant.text", {"turn": 2, "text": "done", "reply": "done", "summary": ""})
            # like real GA: the final (tool-less) turn never fires turn.end
            e("run.end", {})
        self.ctx.emit("agent.chunk", task)
        return "x"

    def abort(self):
        self.aborts += 1
        self.release.set()


def _req(url, data=None, headers=None):
    body = None if data is None else json.dumps(data).encode()
    r = urllib.request.Request(url, data=body, headers=headers or {}, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def _wait_idle(base):
    for _ in range(100):
        _, s = _req(base + "api/state")
        if not s["running"]:
            return s
        time.sleep(0.05)
    raise AssertionError("still running")


def _start(tmp_path):
    rt = _mount_with(tmp_path, WebAgent, "ui-web", {"port": 0, "open_browser": False, "log": lambda m: None})
    fe = rt.ctx.get("frontend")
    offs = fe._subscribe()

    def off():
        for f in offs:
            f()
    base = fe.start()
    return rt, fe, off, base


def test_ui_web_page_run_state_and_errors(tmp_path):
    rt, fe, off, base = _start(tmp_path)
    try:
        assert base.startswith("http://127.0.0.1:")
        with urllib.request.urlopen(base, timeout=5) as r:
            page = r.read().decode("utf-8")
        assert r.headers["Content-Type"].startswith("text/html") and "/api/events" in page
        assert _req(base + "api/run", {"task": "  "})[0] == 400
        assert _req(base + "api/run", {"task": "hi"}) == (202, {"ok": True})
        s = _wait_idle(base)
        assert [(m["role"], m["text"], m["status"]) for m in s["messages"]] == [
            ("user", "hi", "done"), ("assistant", "<b>re:</b>hi", "done")]
        assert _req(base + "api/run", {"task": "boom"})[0] == 202
        last = _wait_idle(base)["messages"][-1]
        assert last["status"] == "error" and "kaput" in last["error"]
        # cross-site POST is refused; same-origin passes
        assert _req(base + "api/run", {"task": "x"}, {"Origin": "http://evil.example"})[0] == 403
        assert _req(base + "api/abort", {}, {"Origin": base.rstrip("/")})[0] == 202
        assert _req(base + "nope")[0] == 404
    finally:
        off()
        rt.dispose()


def test_ui_web_busy_abort_and_sse(tmp_path):
    rt, fe, off, base = _start(tmp_path)
    try:
        sse = urllib.request.urlopen(base + "api/events", timeout=5)
        assert sse.readline().strip() == b"event: snapshot"
        assert json.loads(sse.readline()[len(b"data: "):]) == {"running": False, "messages": []}
        sse.readline()
        assert _req(base + "api/run", {"task": "wait"})[0] == 202
        assert _req(base + "api/run", {"task": "again"})[0] == 409
        events = []
        for _ in range(3):  # start, chunk ... then abort -> done
            events.append(sse.readline().strip().decode())
        assert events[0] == "event: start"
        assert _req(base + "api/abort", {}) == (202, {"ok": True, "running": True})
        s = _wait_idle(base)
        assert s["messages"][-1]["status"] == "aborted"
        agent = rt.ctx.get("agent")
        assert agent.aborts == 1 and agent.calls == ["wait"]
        rest = b""
        while b"event: done" not in rest:
            rest += sse.readline()
        assert b'"aborted"' in sse.readline()
        sse.close()
    finally:
        off()
        rt.dispose()
    assert fe.server is None  # scope disposal stopped the server


def test_ui_web_main_returns_on_stop(tmp_path):
    rt = _mount_with(tmp_path, WebAgent, "ui-web", {"port": 0, "open_browser": False, "log": lambda m: None})
    fe = rt.ctx.get("frontend")
    box = {}
    t = threading.Thread(target=lambda: box.setdefault("rc", fe.main(task="hi")))
    t.start()
    try:
        for _ in range(100):
            if fe.url and not fe.running and fe.messages:
                break
            time.sleep(0.05)
        assert fe.messages[-1]["text"] == "<b>re:</b>hi"
        fe.stop()
        t.join(5)
        assert box.get("rc") == 0
    finally:
        rt.dispose()


def test_ui_web_structured_turns_and_tool_cards(tmp_path):
    rt, fe, off, base = _start(tmp_path)
    try:
        # events outside a run are ignored
        rt.ctx.emit("turn.start", {"turn": 9})
        assert _req(base + "api/run", {"task": "tool"})[0] == 202
        last = _wait_idle(base)["messages"][-1]
        assert last["status"] == "done"
        t1, t2 = last["turns"]
        assert (t1["turn"], t1["summary"], t1["reply"], t1["status"]) == (1, "calc", "go", "done")
        (tool,) = t1["tools"]
        assert (tool["id"], tool["name"], tool["args"], tool["status"], tool["ok"], tool["seconds"]) == (
            "1.0", "code_run", {"script": "1+1"}, "done", True, 0.5)
        assert '"stdout": "2"' in tool["data"]
        assert (t2["reply"], t2["tools"], t2["status"]) == ("done", [], "done")
        # a plain run carries no turns, so the page falls back to text
        assert _req(base + "api/run", {"task": "hi"})[0] == 202
        assert "turns" not in _wait_idle(base)["messages"][-1]
    finally:
        off()
        rt.dispose()


def test_ui_web_clips_large_tool_data():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location(
        "uiweb_main", Path(__file__).resolve().parents[1] / "ga_harness" / "plugins" / "ui-web" / "main.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    out = m._clip("x" * (m.MAX_TOOL_DATA + 5))
    assert out.startswith("x" * m.MAX_TOOL_DATA) and out.endswith("(5 more chars)")
    assert m._clip(None) == "" and m._clip("ok") == "ok"
