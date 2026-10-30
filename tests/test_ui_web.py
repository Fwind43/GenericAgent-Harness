import json
import re
import threading
import time
import urllib.error
import urllib.parse
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
            e("usage", {"turn": 1, "input": 100, "cache_read": 80, "cache_write": 0, "output": 7})
            e("turn.end", {"turn": 1})
            e("turn.start", {"turn": 2})
            e("assistant.text", {"turn": 2, "text": "done", "reply": "done", "summary": ""})
            # like real GA: the final (tool-less) turn never fires turn.end
            e("usage.total", {"calls": 1, "input": 100, "cache_read": 80, "cache_write": 0, "output": 7})
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


def _open_sse(base):
    """Open /api/events; return (stream, first event line), skipping the comment/blank prelude."""
    sse = urllib.request.urlopen(base + "api/events", timeout=5)
    while True:
        line = sse.readline()
        if not line:
            raise AssertionError("SSE stream closed before the first event")
        if line.strip() and not line.startswith(b":"):
            return sse, line.strip()


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
        assert r.headers["Content-Type"].startswith("text/html") and '<div id="root">' in page
        # the React host bundle, not the HTML shell, opens the event stream
        m = re.search(r'<script type="module"[^>]*\bsrc="(/assets/[^"]+\.js)"', page)
        assert m, "host bundle script missing from the page"
        status, _, js = _get(base + m.group(1).lstrip("/"))
        assert status == 200 and "/api/events" in js
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
        sse, first = _open_sse(base)
        assert first == b"event: snapshot"
        snap = json.loads(sse.readline()[len(b"data: "):])
        port = urllib.parse.urlsplit(base).port
        assert snap.pop("local") == {"url": base, "host": "127.0.0.1", "port": port}
        assert snap == {
            "running": False, "messages": [], "plugins_enabled": False, "web_plugins": [],
        }
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
        assert t1["usage"] == {"input": 100, "cache_read": 80, "cache_write": 0, "output": 7}
        assert "usage" not in t2
        assert last["usage"] == {"calls": 1, "input": 100, "cache_read": 80, "cache_write": 0, "output": 7}
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


def _get(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.status, r.headers["Content-Type"], r.read().decode("utf-8")


def test_ui_web_output_assets(tmp_path):
    rt, fe, off, base = _start(tmp_path)
    try:
        page = _get(base)[2]
        for name, kind in [("output.css", "text/css"), ("output.js", "text/javascript"),
                           ("marked.umd.js", "text/javascript"), ("purify.min.js", "text/javascript")]:
            assert "/ui-web-assets/" + name in page
            status, content_type, body = _get(base + "ui-web-assets/" + name)
            assert status == 200 and content_type.startswith(kind) and body
        for name in ("main.py", "index.html", "../main.py", "%2e%2e/main.py", "nested/output.js"):
            assert _req(base + "ui-web-assets/" + name)[0] == 404
    finally:
        off()
        rt.dispose()


def test_ui_web_host_assets_routes_and_isolation(tmp_path):
    import pytest
    rt, fe, off, base = _start(tmp_path)
    try:
        d = tmp_path / "wp"
        d.mkdir()
        (d / "client.js").write_text("GAH.define('demo', {});")
        (d / "client.css").write_text(".demo{}")
        (d / "head.js").write_text("/*head*/")

        def boom(req):
            raise RuntimeError("bad plugin")
        routes = {("GET", "ping"): lambda req: {"pong": req["query"].get("q")},
                  ("POST", "/echo/"): lambda req: (201, req["body"]),
                  ("GET", "boom"): boom}
        un = fe.web.register("demo", script=d / "client.js", style=d / "client.css", head=d / "head.js",
                             routes=routes, order=5)
        fe.web.register("late", style=d / "client.css")
        m = fe.web.manifest()
        assert [x["name"] for x in m] == ["demo", "late"]
        assert m[0]["script"].startswith("/web/demo/client.js?v=") and "script" not in m[1]
        assert _req(base + "api/state")[1]["web_plugins"] == m
        # page head carries style + head script; assets are served with proper types
        page = _get(base)[2]
        assert 'href="/web/demo/client.css?v=' in page and 'src="/web/demo/head.js?v=' in page
        assert "<!--gah:head-->" not in page
        st, ct, body = _get(base + "web/demo/client.js")
        assert st == 200 and ct.startswith("text/javascript") and "GAH.define" in body
        assert _get(base + "web/demo/client.css")[1].startswith("text/css")
        assert _req(base + "web/late/client.js")[0] == 404      # not registered for this plugin
        assert _req(base + "web/demo/../x")[0] == 404
        # routes: GET query, POST body + status, plugin error isolated as 500
        assert _req(base + "api/p/demo/ping?q=1") == (200, {"pong": "1"})
        assert _req(base + "api/p/demo/echo", {"a": 1}) == (201, {"a": 1})
        code, err = _req(base + "api/p/demo/boom")
        assert code == 500 and "bad plugin" in err["error"]
        assert _req(base + "api/p/demo/nope")[0] == 404
        assert _req(base + "api/p/demo/echo", {"a": 1}, {"Origin": "http://evil.example"})[0] == 403
        assert _req(base + "api/state")[0] == 200            # page still alive after plugin failure
        # validation
        with pytest.raises(ValueError):
            fe.web.register("demo")
        with pytest.raises(ValueError):
            fe.web.register("Bad Name")
        with pytest.raises(FileNotFoundError):
            fe.web.register("ghost", script=d / "missing.js")
        # unregister removes assets and routes; idempotent
        un()
        un()
        assert [x["name"] for x in fe.web.manifest()] == ["late"]
        assert _req(base + "web/demo/client.js")[0] == 404 and _req(base + "api/p/demo/ping")[0] == 404
    finally:
        off()
        rt.dispose()


def test_ui_web_host_changes_reach_sse(tmp_path):
    rt, fe, off, base = _start(tmp_path)
    try:
        sse, first = _open_sse(base)
        assert first == b"event: snapshot"
        for _ in range(2):  # snapshot data + blank separator
            sse.readline()
        f = tmp_path / "a.css"
        f.write_text("")
        un = fe.web.register("demo", style=f)
        assert sse.readline().strip() == b"event: web.plugins"
        assert [x["name"] for x in json.loads(sse.readline()[len(b"data: "):])] == ["demo"]
        sse.readline()
        fe.web.emit("demo", "tick", {"n": 1})
        assert sse.readline().strip() == b"event: plugin"
        assert json.loads(sse.readline()[len(b"data: "):]) == {"plugin": "demo", "kind": "tick", "data": {"n": 1}}
        sse.readline()
        un()
        assert sse.readline().strip() == b"event: web.plugins"
        assert json.loads(sse.readline()[len(b"data: "):]) == []
        sse.close()
    finally:
        off()
        rt.dispose()


def test_web_theme_plugin_registers_and_is_dormant_elsewhere(tmp_path):
    from ga_harness.kernel.loader import discover
    from tests.test_frontend import PLUGINS
    from ga_harness.plugin_manager import frontend_capabilities
    rt, fe, off, base = _start(tmp_path)
    try:
        assert "web.host" in frontend_capabilities(discover([PLUGINS]))
        m = {x["name"]: x for x in fe.web.manifest()}
        assert "web-theme" not in m       # not in this tree
    finally:
        off()
        rt.dispose()

def test_ui_web_bundled_web_plugins_mount_and_host_css_scope(tmp_path):
    import sys
    from tests.test_frontend import PLUGINS, Runtime, _e, discover, mount
    d = tmp_path / "fake-agent"
    d.mkdir()
    (d / "plugin.toml").write_text('name = "fake-agent"\nentry = "main:apply"\nprovides = ["agent"]\n')
    (d / "main.py").write_text("import sys\ndef apply(ctx, config):\n"
                               "    ctx.provide('agent', sys.modules['tests_frontend_fake'](ctx))\n")
    sys.modules["tests_frontend_fake"] = WebAgent
    rt = Runtime()
    ui = {"name": "ui-web", "config": {"port": 0, "open_browser": False, "log": lambda m: None}, "disabled": False}
    names = ["web-sessions", "web-models", "web-plugins"]
    mount(rt, [_e("fake-agent"), ui] + [_e(n) for n in names], discover([PLUGINS, tmp_path]))
    fe = rt.ctx.get("frontend")
    base = fe.start()
    try:
        m = fe.web.manifest()
        assert [x["name"] for x in m] == names
        page = _get(base)[2]
        for x in m:
            st, ct, body = _get(base + x["script"].lstrip("/"))
            # React plugin bundles are IIFEs that register through the host SDK global
            assert st == 200 and ct.startswith("text/javascript") and ('defineReact("%s",' % x["name"]) in body
            if "style" in x:
                assert 'href="%s"' % x["style"] in page and _get(base + x["style"].lstrip("/"))[0] == 200
        # host chat-form pill styles must not leak into plugin dialogs' forms; the React host links
        # its CSS as stylesheets without data-gah-plugin (that attribute marks plugin assets)
        hrefs = [re.search(r'\bhref="([^"]+)"', tag).group(1) for tag in re.findall(r"<link\b[^>]*>", page)
                 if 'rel="stylesheet"' in tag and "data-gah-plugin" not in tag]
        assert hrefs, "host stylesheets missing from the page"
        css = "".join(_get(base + h.lstrip("/"))[2] for h in hrefs)
        assert css.strip()
        assert not re.search(r"(?m)(^|[{},])\s*form\s*[{:,]", css)  # bare `form` selector, incl. in @media
    finally:
        rt.dispose()
