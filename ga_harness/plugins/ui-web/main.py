"""ui-web: local browser frontend (stdlib only).

Serves ``index.html`` plus a tiny JSON/SSE API on 127.0.0.1 (another bind address only
if the config sets ``host``). One agent, one task at a time, any number of browser tabs.

  GET  /              the page
  GET  /api/state     {"running": bool, "messages": [{"role", "text", "status"}]}
  GET  /api/events    SSE: snapshot | start | chunk | turn | done | ping
                      (turn = {"index", "turn"} built from ga-events; frontends never parse text)
  POST /api/run       {"task": "..."}  -> 202, or 409 while a task is running
  POST /api/abort     -> 202 (no-op when idle)

Config: host (127.0.0.1), port (8765; 0 = any free port), open_browser (true).
Ctrl+C in the terminal aborts a running task and stops the server.
"""
import copy
import json
import queue
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PAGE = Path(__file__).with_name("index.html")
MAX_BODY = 1 << 20
MAX_TOOL_DATA = 20000
EVENTS = ("turn.start", "assistant.text", "tool.call", "tool.result", "turn.end", "usage", "usage.total")
USAGE_KEYS = ("input", "cache_read", "cache_write", "output")


class WebFrontend:
    def __init__(self, ctx, config):
        self.ctx = ctx
        self.host = config.get("host", "127.0.0.1")
        self.port = int(config.get("port", 8765))
        self.open_browser = bool(config.get("open_browser", True))
        console = ctx.get("console")    # ga-stdout captures sys.stdout; talk to the real one
        self.log = config.get("log") or (lambda *m: print(*m, file=console.out, flush=True) if console
                                         else print(*m, flush=True))
        self.lock = threading.Lock()
        self.messages = []          # {"role", "text", "status"[, "error"]}
        self.running = False
        self.aborting = False
        self.clients = set()
        self.server = None
        self.url = None
        self.stopped = threading.Event()
        self._timeout = None

    # ---- state + fan-out (callers hold self.lock) ----
    def _broadcast(self, kind, data):
        msg = f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
        for q in list(self.clients):
            q.put(msg)

    def snapshot(self):
        return copy.deepcopy({"running": self.running, "messages": self.messages})

    def _on_chunk(self, text):
        with self.lock:
            if self.running and self.messages and self.messages[-1]["role"] == "assistant":
                self.messages[-1]["text"] += text
                self._broadcast("chunk", {"text": text})

    # ---- structured events from ga-events ----
    def _turns(self):
        if self.running and self.messages and self.messages[-1]["role"] == "assistant":
            return self.messages[-1].setdefault("turns", [])
        return None

    def _push(self, turns, i):
        self._broadcast("turn", {"index": i, "turn": turns[i]})

    def _find(self, turns, n):
        for i in range(len(turns) - 1, -1, -1):
            if turns[i]["turn"] == n:
                return i
        turns.append({"turn": n, "summary": "", "reply": "", "status": "running", "tools": []})
        return len(turns) - 1

    def _on_event(self, name, d):
        d = d if isinstance(d, dict) else {}
        with self.lock:
            turns = self._turns()
            if turns is None:
                return
            if name == "usage.total":
                total = {k: d.get(k) for k in ("calls",) + USAGE_KEYS}
                self.messages[-1]["usage"] = total
                self._broadcast("usage", total)
                return
            i = self._find(turns, d.get("turn"))
            t = turns[i]
            if name == "assistant.text":
                t["summary"] = d.get("summary") or ""
                t["reply"] = d.get("reply") or ""
            elif name == "tool.call":
                t["tools"].append({"id": d.get("id"), "name": d.get("name"), "args": d.get("args"),
                                   "status": "running"})
            elif name == "tool.result":
                tool = next((x for x in t["tools"] if x["id"] == d.get("id")), None)
                if tool is None:
                    tool = {"id": d.get("id"), "name": d.get("name"), "args": None}
                    t["tools"].append(tool)
                tool.update(status="done", ok=bool(d.get("ok", True)),
                            data=_clip(d.get("data")), seconds=d.get("seconds"))
            elif name == "turn.end":
                t["status"] = "done"
            elif name == "usage":
                t["usage"] = {k: d.get(k) for k in USAGE_KEYS}
            self._push(turns, i)

    def submit(self, task):
        task = (task or "").strip() if isinstance(task, str) else ""
        if not task:
            return 400, {"error": "empty task"}
        with self.lock:
            if self.running:
                return 409, {"error": "a task is already running"}
            self.running, self.aborting = True, False
            self.messages.append({"role": "user", "text": task, "status": "done"})
            self.messages.append({"role": "assistant", "text": "", "status": "running"})
            self._broadcast("start", {"task": task})
        threading.Thread(target=self._work, args=(task,), name="ui-web-turn", daemon=True).start()
        return 202, {"ok": True}

    def _work(self, task):
        status, error = "done", None
        try:
            self.ctx.get("agent").run(task, timeout=self._timeout)
        except BaseException as e:  # report it; never take the server down
            status, error = "error", f"{type(e).__name__}: {e}"
        with self.lock:
            if status == "done" and self.aborting:
                status = "aborted"
            last = self.messages[-1]
            last["status"] = status
            if error:
                last["error"] = error
            # GA never fires turn.end for the final, tool-less turn (and an
            # abort/error can cut any turn short): settle whatever is open.
            turns = last.get("turns") or []
            for i, turn in enumerate(turns):
                if not isinstance(turn, dict):
                    continue
                open_tools = [t for t in turn.get("tools", []) if t.get("status") == "running"]
                if turn.get("status") != "running" and not open_tools:
                    continue
                if turn.get("status") == "running":
                    turn["status"] = status
                for t in open_tools:
                    t["status"] = status
                self._push(turns, i)
            self.running = self.aborting = False
            self._broadcast("done", {"status": status, "error": error})

    def abort(self):
        with self.lock:
            if not self.running:
                return 202, {"ok": True, "running": False}
            self.aborting = True
        self.ctx.get("agent").abort()
        return 202, {"ok": True, "running": True}

    # ---- server lifecycle ----
    def start(self):
        fe = self

        class Handler(_Handler):
            frontend = fe
        self.server = ThreadingHTTPServer((self.host, self.port), Handler)
        self.server.daemon_threads = True
        host, port = self.server.server_address[:2]
        self.url = f"http://{host}:{port}/"
        threading.Thread(target=self.server.serve_forever, name="ui-web-http", daemon=True).start()
        return self.url

    def stop(self):
        server, self.server = self.server, None
        if server is None:
            return
        with self.lock:
            for q in list(self.clients):
                q.put(None)        # end every open SSE stream
        server.shutdown()
        server.server_close()
        self.stopped.set()

    def _subscribe(self):
        offs = [self.ctx.events.on("agent.chunk", self._on_chunk)]
        for name in EVENTS:
            offs.append(self.ctx.events.on(name, lambda d=None, _n=name: self._on_event(_n, d)))
        return offs

    def main(self, task=None, timeout=None) -> int:
        self._timeout = timeout
        offs = self._subscribe()
        try:
            url = self.start()
            self.log(f"[ga-harness web] {url}  (Ctrl+C to stop)")
            if task:
                self.submit(task)
            if self.open_browser:
                webbrowser.open(url)
            try:
                while not self.stopped.wait(0.5):
                    pass
            except KeyboardInterrupt:
                if self.running:
                    self.log("[web] aborting running task...")
                    self.abort()
            return 0
        finally:
            for off in offs:
                off()
            self.stop()


def _clip(data):
    if data is None:
        return ""
    if not isinstance(data, str):
        try:
            data = json.dumps(data, ensure_ascii=False, indent=2, default=str)
        except (TypeError, ValueError):
            data = str(data)
    if len(data) > MAX_TOOL_DATA:
        data = data[:MAX_TOOL_DATA] + f"\n... ({len(data) - MAX_TOOL_DATA} more chars)"
    return data


class _Handler(BaseHTTPRequestHandler):
    frontend: WebFrontend = None
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep the terminal quiet
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _same_origin(self):
        # Browsers always send Origin on cross-site POSTs; reject anything not from this page.
        origin = self.headers.get("Origin")
        return origin is None or origin.rstrip("/") + "/" == self.frontend.url

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            body = PAGE.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif path == "/api/state":
            with self.frontend.lock:
                snap = self.frontend.snapshot()
            self._json(200, snap)
        elif path == "/api/events":
            self._sse()
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if not self._same_origin():
            return self._json(403, {"error": "cross-origin request rejected"})
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self._json(413, {"error": "body too large"})
        raw = self.rfile.read(n) if n else b""
        if path == "/api/run":
            try:
                body = json.loads(raw or b"{}")
            except ValueError:
                return self._json(400, {"error": "invalid json"})
            task = body.get("task") if isinstance(body, dict) else None
            self._json(*self.frontend.submit(task))
        elif path == "/api/abort":
            self._json(*self.frontend.abort())
        else:
            self._json(404, {"error": "not found"})

    def _sse(self):
        fe = self.frontend
        q = queue.Queue()
        with fe.lock:  # snapshot + subscribe atomically: no chunk lost or duplicated
            first = f"event: snapshot\ndata: {json.dumps(fe.snapshot(), ensure_ascii=False)}\n\n"
            fe.clients.add(q)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            self.wfile.write(first.encode("utf-8"))
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=15)
                except queue.Empty:
                    msg = "event: ping\ndata: {}\n\n"
                if msg is None:
                    return
                self.wfile.write(msg.encode("utf-8"))
                self.wfile.flush()
        except OSError:
            pass
        finally:
            with fe.lock:
                fe.clients.discard(q)


def apply(ctx, config):
    fe = WebFrontend(ctx, config or {})
    ctx.provide("frontend", fe)
    ctx.scope.add(fe.stop)
