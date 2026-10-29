"""ui-web: local browser frontend (stdlib only).

Serves the built React page plus a tiny JSON/SSE API on 127.0.0.1 (another bind address only
if the config sets ``host``). One agent, one task at a time, any number of browser tabs.

  GET  /              the page
  GET  /api/state     {"running": bool, "messages": [{"role", "text", "status"}]}
  GET  /api/events    SSE: snapshot | start | chunk | turn | done | ping
                      (turn = {"index", "turn"} built from ga-events; frontends never parse text)
  POST /api/run       {"task": "..."}  -> 202, or 409 while a task is running
  POST /api/abort     -> 202 (no-op when idle)

Web plugins: ordinary plugins that inject ``web.host`` and call
``host.register(name, script=, style=, head=, routes=)``. Their assets are served under
``/web/<name>/`` and their routes under ``/api/p/<name>/<path>``; the page loads them at
runtime (``GAH.define`` in the browser) and drops them again when they are withdrawn.

Config: host (127.0.0.1), port (8765; 0 = any free port), open_browser (true), token, ready_file.
Environment overrides for embedding (the desktop shell sets these):
  GAH_WEB_PORT, GAH_WEB_OPEN_BROWSER (0/1), GAH_WEB_TOKEN (require this token; the page is
  entered once via ``/?gah_token=...`` which sets an HttpOnly cookie), GAH_WEB_READY_FILE
  (JSON {"url", "pid"} written atomically once listening; never contains the token),
  GAH_WEB_EXIT_ON_STDIN_EOF=1 (stop when the parent closes stdin, e.g. it crashed).
Ctrl+C in the terminal aborts a running task and stops the server.
"""
import copy
import hmac
import os
import sys
import html
import json
import mimetypes
import queue
import re
import threading
import time
import webbrowser
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from ga_harness import presets, uploads
from ga_harness.sessions import EFFORTS, apply_effort

DIST = Path(__file__).with_name("dist")
UNBUILT = ("<!doctype html><meta charset=\"utf-8\"><title>GenericAgent-Harness</title>"
           "<p>Web UI is not built. Run <code>npm install</code> and <code>npm run build</code> in <code>frontend/</code>.</p>")
MAX_BODY = 1 << 20
MAX_TOOL_DATA = 20000
EVENTS = ("turn.start", "assistant.delta", "assistant.text", "tool.call", "tool.result", "turn.end", "usage", "usage.total", "llm.timed")
USAGE_KEYS = ("input", "cache_read", "cache_write", "output")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
ASSET_TYPES = {"script": "text/javascript; charset=utf-8", "head": "text/javascript; charset=utf-8",
               "style": "text/css; charset=utf-8"}
ASSET_FILES = {"script": "client.js", "head": "head.js", "style": "client.css"}


def _peek_pipe_until_closed(stream, interval=0.5):
    """Wait for EOF on a Windows stdin pipe without a blocking ReadFile.

    A thread parked in a synchronous ReadFile on the inherited stdin pipe makes every
    ``multiprocessing`` spawn child hang during interpreter start-up (the child's own
    stdin probing waits on the same pipe), which froze run starts under the desktop shell.
    Polling with PeekNamedPipe never holds the pipe. Returns False when not applicable
    (non-Windows or stdin is not a pipe) so the caller falls back to blocking reads.
    """
    if os.name != "nt":
        return False
    try:
        import ctypes
        import msvcrt
        from ctypes import wintypes
        fd = stream.fileno()
        handle = msvcrt.get_osfhandle(fd)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetFileType.argtypes = [wintypes.HANDLE]
        kernel32.GetFileType.restype = wintypes.DWORD
        if kernel32.GetFileType(handle) != 3:      # FILE_TYPE_PIPE
            return False
        peek = kernel32.PeekNamedPipe
        peek.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p,
                         ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
        peek.restype = wintypes.BOOL
    except (OSError, ValueError, AttributeError, ImportError):
        return False
    avail = wintypes.DWORD()
    while True:
        if not peek(handle, None, 0, None, ctypes.byref(avail), None):
            return True                             # broken pipe: parent went away
        if avail.value:
            if not os.read(fd, avail.value):        # data is ready, so this cannot block
                return True
            continue
        time.sleep(interval)


class WebHost:
    """Registry of browser-side plugins (the ``web.host`` capability)."""

    def __init__(self, frontend):
        self.frontend = frontend
        self.lock = threading.Lock()
        self.items = {}
        self.seq = 0

    def register(self, name, *, script=None, style=None, head=None, routes=None, order=100):
        if not isinstance(name, str) or not NAME_RE.match(name):
            raise ValueError(f"invalid web plugin name: {name!r}")
        assets = {}
        for kind, path in (("script", script), ("style", style), ("head", head)):
            if path is not None:
                path = Path(path)
                if not path.is_file():
                    raise FileNotFoundError(f"{name}: {kind} asset not found: {path}")
                assets[kind] = path
        table = {}
        for key, fn in (routes or {}).items():
            method, sub = key
            method = str(method).upper()
            if method not in ("GET", "POST") or not callable(fn):
                raise ValueError(f"{name}: invalid route {key!r}")
            table[(method, str(sub).strip("/"))] = fn
        with self.lock:
            if name in self.items:
                raise ValueError(f"web plugin already registered: {name}")
            self.seq += 1
            item = {"name": name, "assets": assets, "routes": table, "order": int(order), "rev": self.seq}
            self.items[name] = item
        self.frontend.web_plugins_changed()

        def unregister():
            with self.lock:
                if self.items.get(name) is not item:
                    return
                del self.items[name]
            self.frontend.web_plugins_changed()
        return unregister

    def emit(self, name, kind, data=None):
        """Push ``{plugin, kind, data}`` to every page (``api.on(kind)`` in the browser)."""
        self.frontend.broadcast("plugin", {"plugin": name, "kind": kind, "data": data})

    def manifest(self):
        with self.lock:
            items = sorted(self.items.values(), key=lambda i: (i["order"], i["name"]))
            return [{"name": i["name"], "rev": i["rev"],
                     **{k: f"/web/{i['name']}/{ASSET_FILES[k]}?v={i['rev']}" for k in i["assets"]}}
                    for i in items]

    def asset(self, name, filename):
        with self.lock:
            item = self.items.get(name)
        if item:
            for kind, fname in ASSET_FILES.items():
                if fname == filename and kind in item["assets"]:
                    return item["assets"][kind], ASSET_TYPES[kind]
        return None

    def route(self, name, method, sub):
        with self.lock:
            item = self.items.get(name)
        return item and item["routes"].get((method, sub.strip("/")))

    def head_html(self):
        out = []
        for m in self.manifest():
            if "style" in m:
                out.append(f'<link rel="stylesheet" href="{html.escape(m["style"])}" data-gah-plugin="{m["name"]}">')
            if "head" in m:
                out.append(f'<script src="{html.escape(m["head"])}" data-gah-plugin="{m["name"]}"></script>')
        return "\n".join(out)


class WebFrontend:
    def __init__(self, ctx, config):
        self.ctx = ctx
        self.host = config.get("host", "127.0.0.1")
        env = os.environ
        self.port = int(env.get("GAH_WEB_PORT") or config.get("port", 8765))
        flag = env.get("GAH_WEB_OPEN_BROWSER")
        self.open_browser = (bool(config.get("open_browser", True)) if flag is None
                             else flag.strip().lower() not in ("", "0", "false", "no"))
        self.token = env.get("GAH_WEB_TOKEN") or config.get("token") or None
        self.ready_file = env.get("GAH_WEB_READY_FILE") or config.get("ready_file") or None
        self.exit_on_stdin_eof = env.get("GAH_WEB_EXIT_ON_STDIN_EOF") == "1"
        console = ctx.get("console")    # ga-stdout captures sys.stdout; talk to the real one
        self.log = config.get("log") or (lambda *m: print(*m, file=console.out, flush=True) if console
                                         else print(*m, flush=True))
        self.lock = threading.Lock()
        self.sessions = ctx.get("sessions")
        self.runs = ctx.get("runs")
        self.models = ctx.get("models")
        self.plugins = ctx.get("plugin.manager")
        self.messages = self.sessions.current()["messages"] if self.sessions else []
        self.persistence_error = None
        self.running = False
        self.aborting = False
        self.clients = set()
        self.server = None
        self.url = None
        self.stopped = threading.Event()
        self._timeout = None
        self.web = WebHost(self)
        if self.runs:
            for kind in ("run.started", "run.event", "run.cancelling", "run.finished"):
                ctx.on(kind, lambda data, kind=kind: self.broadcast(kind, data))

    def broadcast(self, kind, data):
        with self.lock:
            self._broadcast(kind, data)

    def web_plugins_changed(self):
        self.broadcast("web.plugins", self.web.manifest())

    # ---- state + fan-out (callers hold self.lock) ----
    def _broadcast(self, kind, data):
        msg = f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
        for q in list(self.clients):
            q.put(msg)

    def snapshot(self):
        data = {"running": self.running, "messages": self.messages}
        if self.sessions:
            data.update(session_id=self.sessions.current()["id"], sessions=self.sessions.listing(),
                        persistence_error=self.persistence_error)
        if self.runs:
            with self.sessions.lock:
                selected = self.sessions.current()
                active = self.runs.active_for(selected["id"])
                data.update(session_id=selected["id"], messages=selected["messages"],
                            running=active is not None, run_id=active["id"] if active else None,
                            runs=self.runs.listing(), parallel_runs=True)
        if self.models:
            data["models"] = self.models.catalog()
        data["plugins_enabled"] = self.plugins is not None
        agent = self.ctx.get("ga.agent")
        if self.sessions and agent is not None:
            data["effort"] = {"current": getattr(agent, "gah_reasoning_effort", None), "options": list(EFFORTS)}
        if self.sessions and self.runs:
            data["presets"] = presets.catalog((self.sessions.current()["state"] or {}).get("preset"))
        data = copy.deepcopy(data)
        data["web_plugins"] = self.web.manifest()
        return self.ctx.waterfall("web.snapshot", data)

    # ---- local file references (read-only; workspaces + GA root) ----
    FILE_LIMIT = 50 << 20
    INLINE_TYPES = ("image/", "audio/", "video/", "application/pdf")

    def file_roots(self):
        """Directories a chat file reference may read from: every known workspace plus the GA root."""
        with self.lock:
            scope = self.snapshot().get("scope") or {}
        found = [scope.get("workspace")] + [p.get("workspace") for p in scope.get("projects") or []
                                            if isinstance(p, dict)]
        found.append(os.environ.get("GA_ROOT"))
        agent = self.ctx.get("ga.agent")
        module = sys.modules.get(type(agent).__module__) if agent is not None else None
        if getattr(module, "__file__", None):
            found.append(os.path.dirname(module.__file__))
        roots = []
        for raw in found:
            if not raw or not isinstance(raw, str):
                continue
            try:
                root = Path(raw).expanduser().resolve()
            except (OSError, RuntimeError):
                continue
            if root.is_dir() and root not in roots:
                roots.append(root)
        return roots, scope.get("workspace")

    def resolve_file(self, raw):
        """-> (Path, root) for an existing regular file under an allowed root, else raise LookupError."""
        raw = str(raw or "").strip()
        if raw.lower().startswith("file:"):
            from urllib.parse import unquote
            raw = unquote(urlsplit(raw).path)
            if re.match(r"^/[A-Za-z]:[/\\]", raw):
                raw = raw[1:]
        if not raw or "\0" in raw:
            raise LookupError("no path")
        roots, workspace = self.file_roots()
        target = Path(raw).expanduser()
        if not target.is_absolute():
            if not workspace:
                raise LookupError("relative path without a workspace")
            target = Path(workspace) / target
        try:
            target = target.resolve()
        except (OSError, RuntimeError):
            raise LookupError("unresolvable path")
        root = next((r for r in roots if target.is_relative_to(r)), None)
        if root is None:
            raise PermissionError("outside workspaces and GA root")
        if not target.is_file():
            raise LookupError("not a file")
        return target, root

    def session_action(self, body):
        if not self.sessions:
            return 404, {"error": "session-store is not enabled"}
        with self.lock:
            if self.running:
                return 409, {"error": "wait for the running task to finish"}
            try:
                if not self.runs:
                    self.sessions.save(self.messages)
                selected = self.sessions.change(
                    body.get("action"), body.get("id"), body.get("title"),
                    workspace=body.get("workspace"), project_id=body.get("project_id"),
                    parent_id=body.get("parent_id"))
                self.messages = selected["messages"]
                self.persistence_error = None
                snap = self.snapshot()
            except ValueError as e:
                return 400, {"error": str(e)}
            except RuntimeError as e:
                return 409, {"error": str(e)}
            except Exception:
                return 503, {"error": "session storage failed; current conversation was kept"}
            self._broadcast("snapshot", snap)
            return 200, snap

    def plugin_catalog(self):
        if not self.plugins:
            return 404, {"error": "plugin-manager is not enabled"}
        with self.lock:
            try:
                return 200, self.plugins.catalog()
            except Exception:
                return 503, {"error": "plugin settings could not be read; check the local settings file"}

    def plugin_action(self, body):
        if not self.plugins:
            return 404, {"error": "plugin-manager is not enabled"}
        if body.get("action") == "install":
            return self.plugin_install(body)
        with self.lock:
            if self.running:
                return 409, {"error": "wait for the running task to finish"}
            try:
                return 200, self.plugins.change(body)
            except ValueError as e:
                return 400, {"error": str(e)}
            except RuntimeError as e:
                return 409, {"error": str(e)}
            except Exception:
                return 503, {"error": "plugin settings could not be saved; reload before retrying"}

    def plugin_install(self, body):
        # Installing can take minutes; never hold the frontend lock meanwhile.
        with self.lock:
            if self.running:
                return 409, {"error": "wait for the running task to finish"}
        try:
            return 200, self.plugins.install(body)
        except ValueError as e:
            return 400, {"error": str(e)}
        except RuntimeError as e:
            return 409, {"error": str(e)}
        except Exception:
            return 503, {"error": "package installation could not be started"}

    def model_config(self):
        if not self.models:
            return 404, {"error": "model-store is not enabled"}
        with self.lock:
            try:
                return 200, self.models.config()
            except Exception:
                return 503, {"error": "model configuration could not be read"}

    def effort_action(self, body):
        agent = self.ctx.get("ga.agent")
        if not self.sessions or agent is None:
            return 404, {"error": "session-store is not enabled"}
        value = body.get("effort", body.get("value")) or None
        if value is not None and value not in EFFORTS:
            return 400, {"error": "unknown reasoning effort"}
        with self.lock:
            if self.running:
                return 409, {"error": "wait for the running task to finish"}
            old = getattr(agent, "gah_reasoning_effort", None)
            agent.gah_reasoning_effort = value
            try:
                self.sessions.remember(effort=value)
            except RuntimeError as e:
                agent.gah_reasoning_effort = old
                return 409, {"error": str(e)}
            except Exception:
                agent.gah_reasoning_effort = old
                return 503, {"error": "session could not be saved"}
            snap = self.snapshot()
            self._broadcast("snapshot", snap)
            return 200, snap

    def preset_action(self, body):
        if not self.sessions or not self.runs:
            return 404, {"error": "agent presets require session-store and run-store"}
        value = body.get("preset", body.get("value")) or None
        if value is not None and presets.get(value) is None:
            return 400, {"error": "unknown agent preset"}
        with self.lock:
            current = self.sessions.current() or {}
            if current.get("messages") and value != (current.get("state") or {}).get("preset"):
                return 409, {"error": "the agent mode is fixed once the conversation has started"}
            try:
                self.sessions.remember(preset=value)
            except RuntimeError as e:
                return 409, {"error": str(e)}
            except Exception:
                return 503, {"error": "session could not be saved"}
            snap = self.snapshot()
            self._broadcast("snapshot", snap)
            return 200, snap

    def model_remote(self, body):
        """Fetch a provider's model list; network-bound, so the frontend lock is not held."""
        if not self.models:
            return 404, {"error": "model-store is not enabled"}
        try:
            return 200, self.models.remote(body)
        except ValueError as e:
            return 400, {"error": str(e)}
        except Exception:
            return 500, {"error": "could not list provider models"}

    def model_action(self, body, configure=False):
        if not self.models:
            return 404, {"error": "model-store is not enabled"}
        with self.lock:
            if self.running:
                return 409, {"error": "wait for the running task to finish"}
            try:
                settings = self.models.change(body) if configure else None
                if not configure:
                    previous = self.models.catalog().get("current")
                    self.models.select(body.get("id"))
                    agent = self.ctx.get("ga.agent")
                    if self.sessions and agent is not None:
                        try:
                            self.sessions.remember(model=getattr(getattr(agent.llmclient, "backend", None), "name", ""))
                        except Exception:
                            # Keep the shown selection identical to what the session will run.
                            if isinstance(previous, int):
                                self.models.select(previous)
                            raise
                snap = self.snapshot()
            except ValueError as e:
                return 400, {"error": str(e)}
            except RuntimeError as e:
                return 409, {"error": str(e)}
            except Exception:
                return 503, {"error": "model operation failed; reload settings before retrying"}
            self._broadcast("snapshot", snap)
            return 200, {"state": snap, "config": settings} if configure else snap

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
        turns.append({"turn": n, "summary": "", "reply": "", "thinking": "", "status": "running", "tools": []})
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
            if name == "assistant.delta":
                part, text = d.get("part"), d.get("text") or ""
                if part in ("summary", "reply", "thinking") and text:
                    t[part] = (t.get(part) or "") + text
                    self._broadcast("delta", {"index": i, "turn": t["turn"], "part": part, "text": text})
                return
            if name == "assistant.text":
                t["summary"] = d.get("summary") or ""
                t["reply"] = d.get("reply") or ""
                t["thinking"] = d.get("thinking") or ""
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
            elif name == "llm.timed":
                t["llm"] = {"seconds": d.get("seconds"), "ttft": d.get("ttft")}
            self._push(turns, i)

    def run_query(self, query):
        if not self.runs:
            return 404, {"error": "run-store is not enabled"}
        try:
            rid = query.get("run_id", [None])[0]
            if rid and query.get("events", [None])[0] == "1":
                self.runs.get(rid)
                return 200, {"events": self.runs.events(rid, after=query.get("after", [0])[0])}
            if rid:
                return 200, {"run": self.runs.get(rid)}
            return 200, {"runs": self.runs.listing(session_id=query.get("session_id", [None])[0])}
        except (TypeError, ValueError) as e:
            return 400, {"error": str(e)}
        except Exception:
            return 503, {"error": "run storage could not be read"}

    def submit(self, task, *, session_id=None, source="user", attachments=None):
        if self.runs:
            if not isinstance(session_id, str) or not session_id:
                return 400, {"error": "session_id is required"}
            try:
                # No frontend lock here: start emits committed run events.
                run = self.runs.start(task, session_id=session_id, source=source, timeout=self._timeout,
                                      attachments=attachments)
                return 202, {"ok": True, "run": run, "session_id": run["session_id"], "run_id": run["id"]}
            except ValueError as e:
                return 400, {"error": str(e)}
            except RuntimeError as e:
                return 409, {"error": str(e)}
            except Exception:
                return 503, {"error": "run could not be started"}
        task = (task or "").strip() if isinstance(task, str) else ""
        try:
            # The legacy single-agent path has no image channel; it gets the file paths.
            task = uploads.task_text(task, uploads.resolve(attachments))
        except ValueError as e:
            return 400, {"error": str(e)}
        if not task:
            return 400, {"error": "empty task"}
        with self.lock:
            if self.running:
                return 409, {"error": "a task is already running"}
            agent = self.ctx.get("ga.agent")
            backend = getattr(getattr(agent, "llmclient", None), "backend", None)
            model = getattr(backend, "model", "") or getattr(backend, "name", "") or ""
            effort = None
            if backend is not None and hasattr(backend, "reasoning_effort"):
                effort = backend.reasoning_effort
                if self.sessions:
                    # Match apply_effort without mutating the client before the task is saved.
                    effort = getattr(agent, "gah_reasoning_effort", None) or getattr(backend, "_gah_effort_default", effort)
                effort = effort or "default"
            created_at = time.time()
            metadata = {"model": model, "reasoning_effort": effort, "created_at": created_at}
            messages = self.messages + [{"role": "user", "text": task, "status": "done", "created_at": created_at},
                                        {"role": "assistant", "text": "", "status": "running", **metadata}]
            if self.sessions:
                try:
                    self.sessions.save(messages)
                except Exception:
                    return 503, {"error": "session could not be saved; task was not started"}
            self.messages = messages
            self.running, self.aborting = True, False
            self._broadcast("start", {"task": task, **metadata})
        threading.Thread(target=self._work, args=(task,), name="ui-web-turn", daemon=True).start()
        return 202, {"ok": True}

    def _work(self, task):
        status, error = "done", None
        try:
            ga = self.ctx.get("ga.agent")
            if self.sessions and ga is not None:
                apply_effort(ga)
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
            if self.sessions:
                try:
                    self.sessions.save(self.messages)
                    self.persistence_error = None
                except Exception:
                    self.persistence_error = "会话保存失败，请勿关闭页面；重试切换会话可再次保存"
            self.running = self.aborting = False
            self._broadcast("done", {"status": status, "error": error})
            if self.sessions:
                self._broadcast("snapshot", self.snapshot())

    def abort(self, body=None):
        if self.runs:
            body = body or {}
            rid, sid = body.get("run_id"), body.get("session_id")
            if not isinstance(rid, str) or not rid or not isinstance(sid, str) or not sid:
                return 400, {"error": "run_id and session_id are required"}
            try:
                if self.runs.get(rid)["session_id"] != sid:
                    return 400, {"error": "run does not belong to this session"}
                return 202, {"ok": True, "run": self.runs.cancel(rid)}
            except ValueError as e:
                return 400, {"error": str(e)}
            except Exception:
                return 503, {"error": "run could not be cancelled"}
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
        self.cookie_name = f"gah_token_{port}"   # cookies ignore ports; keep instances apart
        threading.Thread(target=self.server.serve_forever, name="ui-web-http", daemon=True).start()
        return self.url

    def _write_ready(self):
        if not self.ready_file:
            return
        target = Path(self.ready_file)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_text(json.dumps({"url": self.url, "pid": os.getpid()}), encoding="utf-8")
        os.replace(tmp, target)

    def _watch_stdin(self):
        stream = getattr(sys.stdin, "buffer", None)
        if stream is None:
            return

        def watch():
            try:
                if not _peek_pipe_until_closed(stream):
                    while stream.read(4096):
                        pass
            except (OSError, ValueError):
                pass
            self.log("[web] parent closed stdin; stopping")
            if self.running:
                self.abort()
            self.stop()
        threading.Thread(target=watch, name="ui-web-stdin", daemon=True).start()

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
            self.log(f"[GenericAgent-Harness web] {url}  (Ctrl+C to stop)")
            self._write_ready()
            if self.exit_on_stdin_eof:
                self._watch_stdin()
            if task:
                self.submit(task)
            if self.open_browser:
                # A token-protected page must be entered once with the token to get its cookie.
                webbrowser.open(url + (f"?gah_token={self.token}" if self.token else ""))
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

    def _bytes(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _file(self):
        """GET /api/file?path=P[&info=1][&download=1]: read a referenced local file."""
        query = parse_qs(urlsplit(self.path).query)
        try:
            target, root = self.frontend.resolve_file(query.get("path", [""])[0])
        except PermissionError as e:
            return self._json(403, {"error": str(e)})
        except LookupError as e:
            return self._json(404, {"error": str(e)})
        size = target.stat().st_size
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if query.get("info", [""])[0]:
            return self._json(200, {"path": str(target), "name": target.name, "size": size,
                                    "mime": mime, "root": str(root)})
        inline = mime.startswith(self.frontend.INLINE_TYPES)
        media = mime.startswith(("video/", "audio/"))
        if size > self.frontend.FILE_LIMIT and not media:   # media streams by range, any size
            return self._json(413, {"error": "file too large"})
        try:
            fh = target.open("rb")
        except OSError as e:
            return self._json(404, {"error": f"unreadable: {e}"})
        with fh:
            if not inline and b"\0" not in fh.read(8192):
                mime = "text/plain; charset=utf-8"     # never render HTML/JS from disk as active content
            start, end = 0, size - 1
            ranged = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range", "").strip())
            if ranged and size and (ranged.group(1) or ranged.group(2)):
                a, b = ranged.groups()
                if a:
                    start, end = int(a), (min(int(b), size - 1) if b else size - 1)
                else:
                    start = max(0, size - int(b))
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
            else:
                ranged = None
            self.send_response(206 if ranged else 200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(end - start + 1 if size else 0))
            self.send_header("Accept-Ranges", "bytes")
            if ranged:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self._file_headers(query, target, mime, inline)
            fh.seek(start)
            left = end - start + 1 if size else 0
            try:
                while left > 0:
                    chunk = fh.read(min(left, 1 << 20))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass                                    # players abort ranges while seeking

    def _file_headers(self, query, target, mime, inline):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if mime != "application/pdf":
            # Opaque origin, no scripts: an SVG or text file opened in a tab cannot reach the API.
            self.send_header("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; "
                                                        "style-src 'unsafe-inline'; media-src 'self'")
        from urllib.parse import quote
        disposition = "attachment" if query.get("download", [""])[0] or (not inline and mime.startswith("application/")) else "inline"
        self.send_header("Content-Disposition", f"{disposition}; filename*=UTF-8''{quote(target.name)}")
        self.end_headers()

    def _plugin_route(self, method, path, body):
        name, _, sub = path[len("/api/p/"):].partition("/")
        fn = self.frontend.web.route(name, method, sub)
        if not fn:
            return self._json(404, {"error": "not found"})
        query = {}
        if "?" in self.path:
            from urllib.parse import parse_qsl
            query = dict(parse_qsl(self.path.split("?", 1)[1]))
        try:
            result = fn({"method": method, "path": sub, "query": query, "body": body or {}})
        except Exception as e:  # a broken plugin must not take the page down
            self.frontend.log(f"[web] plugin {name} {method} /{sub} failed: {type(e).__name__}: {e}")
            return self._json(500, {"error": f"plugin {name} failed: {type(e).__name__}: {e}"})
        code, obj = result if isinstance(result, tuple) else (200, result)
        self._json(code, obj)

    def _same_origin(self):
        # Browsers always send Origin on cross-site POSTs; reject anything not from this page.
        origin = self.headers.get("Origin")
        return origin is None or origin.rstrip("/") + "/" == self.frontend.url

    def _authorized(self):
        token = self.frontend.token
        if not token:
            return True
        header = self.headers.get("X-GAH-Token")
        if header and hmac.compare_digest(header, token):
            return True
        try:
            morsel = SimpleCookie(self.headers.get("Cookie") or "").get(self.frontend.cookie_name)
        except CookieError:
            return False
        return bool(morsel) and hmac.compare_digest(morsel.value, token)

    def _enter_with_token(self, path):
        """``/?gah_token=X`` -> set the HttpOnly cookie and drop the token from the address bar."""
        token = self.frontend.token
        given = parse_qs(urlsplit(self.path).query).get("gah_token", [""])[0]
        if not (token and given and path in ("/", "/index.html") and hmac.compare_digest(given, token)):
            return False
        self.send_response(303)
        self.send_header("Location", "/")
        self.send_header("Set-Cookie", f"{self.frontend.cookie_name}={token}; Path=/; HttpOnly; SameSite=Strict")
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        return True

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if self._enter_with_token(path):
            return
        if not self._authorized():
            return self._json(401, {"error": "unauthorized"})
        if path in ("/", "/index.html"):
            # The React host and plugin client.js bundles both come from the frontend build.
            built_page = DIST / "index.html"
            if not built_page.is_file():
                return self._bytes(503, UNBUILT.encode("utf-8"), "text/html; charset=utf-8")
            page = built_page.read_text(encoding="utf-8")
            # Plugin assets go last in <head> so plugin CSS overrides the host bundle at equal specificity.
            page = page.replace("<!--gah:head-->", "")
            body = page.replace("</head>", self.frontend.web.head_html() + "</head>", 1).encode("utf-8")
            self._bytes(200, body, "text/html; charset=utf-8")
        elif path.startswith("/assets/"):
            # Vite's hashed assets only; reject traversal and symlinks outside dist.
            root = (DIST / "assets").resolve()
            asset = (root / path.removeprefix("/assets/")).resolve()
            types = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                     ".svg": "image/svg+xml", ".woff2": "font/woff2"}
            if not asset.is_relative_to(root) or asset.suffix not in types or not asset.is_file():
                return self._json(404, {"error": "not found"})
            try:
                self._bytes(200, asset.read_bytes(), types[asset.suffix])
            except OSError:
                self._json(404, {"error": "asset unavailable"})
        elif path.startswith("/ui-web-assets/"):
            # Host-owned assets only; never expose arbitrary files beside the page.
            assets = {
                "ga-logo.png": "image/png",
                "output.css": "text/css; charset=utf-8",
                "output.js": "text/javascript; charset=utf-8",
                "marked.umd.js": "text/javascript; charset=utf-8",
                "purify.min.js": "text/javascript; charset=utf-8",
            }
            name = path.removeprefix("/ui-web-assets/")
            if name not in assets:
                return self._json(404, {"error": "not found"})
            try:
                self._bytes(200, DIST.with_name(name).read_bytes(), assets[name])
            except OSError:
                self._json(404, {"error": "asset unavailable"})
        elif path.startswith("/web/"):
            parts = path.split("/")
            found = len(parts) == 4 and self.frontend.web.asset(parts[2], parts[3])
            if not found:
                return self._json(404, {"error": "not found"})
            try:
                self._bytes(200, found[0].read_bytes(), found[1])
            except OSError:
                self._json(404, {"error": "asset unavailable"})
        elif path.startswith("/api/p/"):
            self._plugin_route("GET", path, None)
        elif path == "/api/web/plugins":
            self._json(200, self.frontend.web.manifest())
        elif path == "/api/file":
            self._file()
        elif path == "/api/state":
            with self.frontend.lock:
                snap = self.frontend.snapshot()
            self._json(200, snap)
        elif path == "/api/runs":
            self._json(*self.frontend.run_query(parse_qs(urlsplit(self.path).query)))
        elif path == "/api/plugins":
            self._json(*self.frontend.plugin_catalog())
        elif path == "/api/models/config":
            self._json(*self.frontend.model_config())
        elif path == "/api/events":
            self._sse()
        elif path.startswith("/api/upload/"):
            found = uploads.locate(path.removeprefix("/api/upload/"))
            if found is None:
                return self._json(404, {"error": "not found"})
            info = uploads.describe(found)
            # Only vision formats render inline; anything else is a download (no HTML/SVG sniffing).
            ctype = info["mime"] if info["image"] else "application/octet-stream"
            self._bytes(200, found.read_bytes(), ctype)
        else:
            self._json(404, {"error": "not found"})

    def _upload(self, n):
        """Raw-body upload: file name in X-File-Name (URL-encoded), type in Content-Type."""
        from urllib.parse import unquote
        if n > uploads.MAX_FILE:
            self.close_connection = True
            return self._json(413, {"error": f"file exceeds {uploads.MAX_FILE >> 20} MB"})
        if n <= 0:
            return self._json(400, {"error": "empty file"})
        name = unquote(self.headers.get("X-File-Name") or "")
        try:
            info = uploads.save(self.rfile, n, name, self.headers.get("Content-Type"))
        except (ValueError, OSError) as e:
            self.close_connection = True
            return self._json(400, {"error": str(e)})
        self._json(200, {"ok": True, "file": info})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if not self._same_origin():
            return self._json(403, {"error": "cross-origin request rejected"})
        if not self._authorized():
            return self._json(401, {"error": "unauthorized"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json(400, {"error": "invalid content length"})
        if path == "/api/upload":
            return self._upload(n)
        if n < 0 or n > MAX_BODY:
            return self._json(413, {"error": "body too large"})
        raw = self.rfile.read(n) if n else b""
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            return self._json(400, {"error": "invalid json"})
        if not isinstance(body, dict):
            return self._json(400, {"error": "expected a JSON object"})
        if path.startswith("/api/p/"):
            return self._plugin_route("POST", path, body)
        if path == "/api/run":
            self._json(*self.frontend.submit(body.get("task"), session_id=body.get("session_id"), source=body.get("source", "user"),
                                          attachments=body.get("attachments")))
        elif path == "/api/sessions":
            self._json(*self.frontend.session_action(body))
        elif path == "/api/plugins":
            self._json(*self.frontend.plugin_action(body))
        elif path == "/api/effort":
            self._json(*self.frontend.effort_action(body))
        elif path == "/api/preset":
            self._json(*self.frontend.preset_action(body))
        elif path == "/api/models/select":
            self._json(*self.frontend.model_action(body))
        elif path == "/api/models/config":
            self._json(*self.frontend.model_action(body, configure=True))
        elif path == "/api/models/remote":
            self._json(*self.frontend.model_remote(body))
        elif path == "/api/abort":
            self._json(*self.frontend.abort(body))
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
    ctx.provide("web.host", fe.web)
    ctx.scope.add(fe.stop)
