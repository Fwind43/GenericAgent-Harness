"""ui-web: local browser frontend (stdlib only).

Serves ``index.html`` plus a tiny JSON/SSE API on 127.0.0.1 (another bind address only
if the config sets ``host``). One agent, one task at a time, any number of browser tabs.

  GET  /              the page
  GET  /api/state     {"running": bool, "messages": [{"role", "text", "status"}]}
  GET  /api/events    SSE: snapshot | start | chunk | done | ping
  POST /api/run       {"task": "..."}  -> 202, or 409 while a task is running
  POST /api/abort     -> 202 (no-op when idle)

Config: host (127.0.0.1), port (8765; 0 = any free port), open_browser (true).
Ctrl+C in the terminal aborts a running task and stops the server.
"""
import json
import queue
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PAGE = Path(__file__).with_name("index.html")
MAX_BODY = 1 << 20


class WebFrontend:
    def __init__(self, ctx, config):
        self.ctx = ctx
        self.host = config.get("host", "127.0.0.1")
        self.port = int(config.get("port", 8765))
        self.open_browser = bool(config.get("open_browser", True))
        self.log = config.get("log") or print
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
        return {"running": self.running, "messages": [dict(m) for m in self.messages]}

    def _on_chunk(self, text):
        with self.lock:
            if self.running and self.messages and self.messages[-1]["role"] == "assistant":
                self.messages[-1]["text"] += text
                self._broadcast("chunk", {"text": text})

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

    def main(self, task=None, timeout=None) -> int:
        self._timeout = timeout
        off = self.ctx.events.on("agent.chunk", self._on_chunk)
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
            off()
            self.stop()


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
