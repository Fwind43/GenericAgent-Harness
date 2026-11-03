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

Config: host (127.0.0.1), port (0 = any free port, the default; external access goes through
plugins such as web-lan/web-tailscale on their own user-chosen ports), open_browser (true), token, ready_file,
allowed_origins (extra browser origins allowed to POST, e.g. a tunnel/reverse-proxy URL),
allow_no_token (false; binding a non-loopback host without a token is refused unless true).
Environment overrides for embedding (the desktop shell sets these):
  GAH_WEB_PORT, GAH_WEB_OPEN_BROWSER (0/1), GAH_WEB_TOKEN (require this token; the page is
  entered via ``/?gah_token=...`` (reusable) which sets an HttpOnly cookie valid 30 days,
  renewed on each page load; the token itself never expires), GAH_WEB_READY_FILE
  (JSON {"url", "pid"} written atomically once listening; never contains the token),
  GAH_WEB_EXIT_ON_STDIN_EOF=1 (stop when the parent closes stdin, e.g. it crashed),
  GAH_WEB_ALLOWED_ORIGINS (comma-separated, added to allowed_origins), GAH_WEB_ALLOW_NO_TOKEN=1.
External access: plugins use ``web.host.allow_origin(url)`` (returns an undo callable),
``web.host.access()`` and ``web.host.set_token()``; see WebHost.
Ctrl+C in the terminal aborts a running task and stops the server.
"""
import copy
import hashlib
import ipaddress
import os
import sys
import html
import json
import time
import re
import threading
import time
import webbrowser
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlsplit

from ga_harness import presets, uploads
from ga_harness.sessions import EFFORTS, apply_effort

from .handler import _Handler, _clip

EVENTS = ("turn.start", "assistant.delta", "assistant.text", "tool.call", "tool.result", "turn.end", "usage", "usage.total", "llm.start", "llm.timed")
USAGE_KEYS = ("input", "cache_read", "cache_write", "output")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
ASSET_TYPES = {"script": "text/javascript; charset=utf-8", "head": "text/javascript; charset=utf-8",
               "style": "text/css; charset=utf-8"}
FILE_TYPES = {"js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
              "json": "application/json; charset=utf-8", "svg": "image/svg+xml",
              "html": "text/html; charset=utf-8"}
ASSET_FILES = {"script": "client.js", "head": "head.js", "style": "client.css"}
WILDCARD_HOSTS = ("", "0.0.0.0", "::")
LOOPBACK_NAMES = ("localhost", "127.0.0.1", "::1")


def normalize_origin(value):
    """``scheme://host[:port]`` (lower-case, default port dropped), or None if not an http(s) origin."""
    if not isinstance(value, str):
        return None
    try:
        parts = urlsplit(value.strip())
        port = parts.port
    except ValueError:
        return None
    scheme, host = parts.scheme.lower(), (parts.hostname or "").lower()
    if scheme not in ("http", "https") or not host:
        return None
    if ":" in host:
        host = f"[{host}]"
    if port is not None and port != (443 if scheme == "https" else 80):
        host = f"{host}:{port}"
    return f"{scheme}://{host}"


def _origin_list(value):
    if isinstance(value, str):
        value = value.split(",")
    out = []
    for item in value or ():
        origin = normalize_origin(item)
        if item and str(item).strip() and origin is None:
            raise ValueError(f"ui-web: invalid allowed origin: {item!r}")
        if origin and origin not in out:
            out.append(origin)
    return out


def _is_ip(host):
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def _is_loopback(host):
    if host in LOOPBACK_NAMES:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


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


DESKTOP_KINDS = ("overlay", "window")
DESKTOP_ANCHORS = ("top", "top-left", "top-right", "bottom", "bottom-left", "bottom-right", "center")


def _desktop_windows(name, desktop, files):
    """Validate ``register(desktop=[...])``: windows the desktop shell opens for a web plugin.

    Each entry is a dict with ``id`` and ``page`` (an ``.html`` name from ``files``), plus optional
    ``kind`` ("overlay": frameless transparent always-on-top pill sized by the page; "window": a
    normal window opened on demand), ``title``, ``width``/``height``, ``anchor`` (overlay start
    position), ``focusable``, ``tray`` (menu label that opens it) and ``data`` (small JSON value
    handed to the page). Browsers ignore all of it; only the desktop shell reads it.
    """
    out, seen = [], set()
    for raw in desktop or ():
        if not isinstance(raw, dict):
            raise ValueError(f"{name}: desktop window must be a dict")
        unknown = set(raw) - {"id", "page", "kind", "title", "width", "height", "anchor", "focusable", "tray", "data"}
        if unknown:
            raise ValueError(f"{name}: unknown desktop window keys {sorted(unknown)}")
        wid, page = str(raw.get("id", "")), str(raw.get("page", ""))
        if not re.match(r"^[a-z0-9][a-z0-9-]{0,31}$", wid) or wid in seen:
            raise ValueError(f"{name}: invalid desktop window id {wid!r}")
        if page not in files or not page.endswith(".html"):
            raise ValueError(f"{name}: desktop page {page!r} must be an .html entry of files")
        kind = raw.get("kind", "overlay")
        anchor = raw.get("anchor", "top")
        if kind not in DESKTOP_KINDS or anchor not in DESKTOP_ANCHORS:
            raise ValueError(f"{name}: invalid desktop window kind/anchor")
        default = (240, 48) if kind == "overlay" else (480, 640)
        item = {"id": wid, "page": page, "kind": kind, "anchor": anchor,
                "title": str(raw.get("title") or name)[:80],
                "width": max(40, min(1600, int(raw.get("width") or default[0]))),
                "height": max(24, min(1200, int(raw.get("height") or default[1]))),
                "focusable": bool(raw.get("focusable", kind == "window"))}
        if raw.get("tray"):
            item["tray"] = str(raw["tray"])[:40]
        if raw.get("data") is not None:
            data = json.loads(json.dumps(raw["data"]))
            if len(json.dumps(data)) > 8192:
                raise ValueError(f"{name}: desktop window data is too large")
            item["data"] = data
        seen.add(wid)
        out.append(item)
    return out


class WebHost:
    """Registry of browser-side plugins (the ``web.host`` capability)."""

    def __init__(self, frontend):
        self.frontend = frontend
        self.lock = threading.Lock()
        self.items = {}
        self.seq = 0

    def register(self, name, *, script=None, style=None, head=None, routes=None, files=None, order=100, desktop=None):
        if not isinstance(name, str) or not NAME_RE.match(name):
            raise ValueError(f"invalid web plugin name: {name!r}")
        assets = {}
        for kind, path in (("script", script), ("style", style), ("head", head)):
            if path is not None:
                path = Path(path)
                if not path.is_file():
                    raise FileNotFoundError(f"{name}: {kind} asset not found: {path}")
                assets[kind] = path
        extra = {}
        for fname, path in (files or {}).items():  # lazily loaded extras: /web/<name>/<fname>
            path = Path(path)
            if not re.match(r"^[A-Za-z0-9._-]+\.(js|css|json|svg|html)$", str(fname)) or fname in ASSET_FILES.values() or not path.is_file():
                raise ValueError(f"{name}: invalid file asset {fname!r}")
            extra[fname] = path
        table = {}
        for key, fn in (routes or {}).items():
            method, sub = key
            method = str(method).upper()
            if method not in ("GET", "POST") or not callable(fn):
                raise ValueError(f"{name}: invalid route {key!r}")
            table[(method, str(sub).strip("/"))] = fn
        windows = _desktop_windows(name, desktop, extra)
        with self.lock:
            if name in self.items:
                raise ValueError(f"web plugin already registered: {name}")
            self.seq += 1
            item = {"name": name, "assets": assets, "files": extra, "routes": table, "order": int(order),
                    "rev": self.seq, "desktop": windows}
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
            out = []
            for i in items:
                m = {"name": i["name"], "rev": i["rev"],
                     **{k: f"/web/{i['name']}/{ASSET_FILES[k]}?v={i['rev']}" for k in i["assets"]}}
                if i["desktop"]:
                    m["desktop"] = [{**{k: v for k, v in w.items() if k != "page"},
                                     "url": f"/web/{i['name']}/{w['page']}?v={i['rev']}"} for w in i["desktop"]]
                out.append(m)
            return out

    def asset(self, name, filename):
        with self.lock:
            item = self.items.get(name)
        if item:
            if filename in item["files"]:
                return item["files"][filename], FILE_TYPES[filename.rsplit(".", 1)[1]]
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

    # ---- external access (for tunnel / reverse-proxy / LAN plugins) ----
    def allow_origin(self, origin):
        """Let ``origin`` (an http(s) URL; path ignored) POST to the API. Returns an undo callable."""
        return self.frontend.add_origin(origin)

    def origins(self):
        return self.frontend.origins()

    def access(self):
        """Non-secret access facts: bind host/port, local url, token_required, allowed origins."""
        fe = self.frontend
        return {"host": fe.host, "port": fe.bound_port, "url": fe.url, "loopback": fe.loopback_only,
                "token_required": bool(fe.token), "origins": fe.origins()}

    def entry_url(self, base=None):
        """``base`` (default: the local url) with the one-time ``?gah_token=`` entry query. Contains the token."""
        base = (base or self.frontend.url or "").split("?", 1)[0].split("#", 1)[0]
        if base and not base.endswith("/"):
            base += "/"
        token = self.frontend.token
        return base + (f"?gah_token={quote(token, safe='')}" if token else "")

    def set_token(self, token):
        """Replace the access token (invalidates existing cookies). Empty is refused when exposed."""
        return self.frontend.set_token(token)


class WebFrontend:
    def __init__(self, ctx, config):
        self.ctx = ctx
        self.host = config.get("host", "127.0.0.1")
        env = os.environ
        self.port = int(env.get("GAH_WEB_PORT") or config.get("port", 0))
        flag = env.get("GAH_WEB_OPEN_BROWSER")
        self.open_browser = (bool(config.get("open_browser", True)) if flag is None
                             else flag.strip().lower() not in ("", "0", "false", "no"))
        self.token = env.get("GAH_WEB_TOKEN") or config.get("token") or None
        flag = env.get("GAH_WEB_ALLOW_NO_TOKEN")
        self.allow_no_token = (bool(config.get("allow_no_token", False)) if flag is None
                               else flag.strip().lower() not in ("", "0", "false", "no"))
        self.loopback_only = _is_loopback(str(self.host).strip("[]").lower())
        if not self.loopback_only and not self.token and not self.allow_no_token:
            raise ValueError(f"ui-web: host {self.host!r} is reachable from other machines; "
                             "set a token (GAH_WEB_TOKEN) or allow_no_token = true")
        self._static_origins = _origin_list(config.get("allowed_origins")) + [
            o for o in _origin_list(env.get("GAH_WEB_ALLOWED_ORIGINS") or "")]
        self._runtime_origins = {}
        self.bound_port = None
        self.ready_file = env.get("GAH_WEB_READY_FILE") or config.get("ready_file") or None
        self.exit_on_stdin_eof = env.get("GAH_WEB_EXIT_ON_STDIN_EOF") == "1"
        console = ctx.get("console")    # ga-stdout captures sys.stdout; talk to the real one
        self.log = config.get("log") or (lambda *m: print(*m, file=console.out, flush=True) if console
                                         else print(*m, flush=True))
        # Re-entrant: a hot plugin change runs under this lock and its web
        # (un)registration broadcasts ``web.plugins`` from the same thread.
        self.lock = threading.RLock()
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
        db_messages = False
        selected_state = None
        if self.sessions:
            data.update(session_id=self.sessions.current(light=True)["id"], sessions=self.sessions.listing(),
                        persistence_error=self.persistence_error)
        if self.runs:
            with self.sessions.lock:
                selected = self.sessions.current()
                active = self.runs.active_for(selected["id"])
                selected_state = selected["state"]
                db_messages = True
                data.update(session_id=selected["id"], messages=selected["messages"],
                            running=active is not None, run_id=active["id"] if active else None,
                            runs=self.runs.listing(), parallel_runs=True)
                # Incremental run events resume from the live transcript; pair it
                # with its own stream position so no fragment is lost or doubled.
                live = self.runs.live_snapshot(selected["id"]) if active else None
                if live:
                    db_messages = False
                    data["messages"] = live["messages"]
                    data["runs"] = [dict(run, seq=live["seq"]) if run["id"] == live["run_id"] else run
                                    for run in data["runs"]]
        if self.models:
            data["models"] = self.models.catalog()
        data["plugins_enabled"] = self.plugins is not None
        if self.bound_port:
            data["local"] = {"url": self.url, "host": self.host, "port": self.bound_port}
        agent = self.ctx.get("ga.agent")
        if self.sessions and agent is not None:
            data["effort"] = {"current": getattr(agent, "gah_reasoning_effort", None), "options": list(EFFORTS)}
        if self.sessions and self.runs:
            data["presets"] = presets.catalog(((selected_state if self.runs else None) or {}).get("preset"))
        # Messages read from the DB are already private to this snapshot; only share-prone data needs copying.
        fresh = data.pop("messages") if db_messages else None
        data = copy.deepcopy(data)
        if fresh is not None:
            data["messages"] = fresh
        data["web_plugins"] = self.web.manifest()
        return self.ctx.waterfall("web.snapshot", data)

    # ---- local file references (read-only; workspaces + GA root) ----
    FILE_LIMIT = 50 << 20
    INLINE_TYPES = ("image/", "audio/", "video/", "application/pdf")

    def file_roots(self):
        """Directories a chat file reference may read from: every known workspace plus the GA root."""
        now = time.monotonic()
        cached = getattr(self, "_roots_cache", None)
        if cached and now - cached[0] < 3.0:
            return cached[1]
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
        self._roots_cache = (now, (roots, scope.get("workspace")))
        return self._roots_cache[1]

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
            if self.running and not self.plugins.run_safe(body.get("name")):
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
            # The mode may change at any point between runs: each run reads the session's preset
            # when it starts, so a change applies from the next message. remember() refuses while
            # this session has an active run.
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
            elif name == "llm.start":
                t["llm"] = {"started": d.get("started")}
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
        if host in WILDCARD_HOSTS:
            host = "127.0.0.1"                 # a wildcard is not browsable; open the loopback alias
        self.bound_port = port
        self.url = f"http://{f'[{host}]' if ':' in host else host}:{port}/"
        threading.Thread(target=self.server.serve_forever, name="ui-web-http", daemon=True).start()
        return self.url

    # ---- external access ----
    def origins(self):
        with self.lock:
            runtime = list(self._runtime_origins)
        return list(dict.fromkeys(self._static_origins + runtime))

    def add_origin(self, origin):
        norm = normalize_origin(origin)
        if norm is None:
            raise ValueError(f"invalid origin: {origin!r}")
        with self.lock:
            self._runtime_origins[norm] = self._runtime_origins.get(norm, 0) + 1
        done = []

        def undo():
            with self.lock:
                if done or norm not in self._runtime_origins:
                    return
                done.append(True)
                self._runtime_origins[norm] -= 1
                if self._runtime_origins[norm] <= 0:
                    del self._runtime_origins[norm]
        return undo

    @property
    def cookie_name(self):
        """Keyed by the token, not the port: cookies ignore ports, the port is random per start,
        and a stable name keeps phones signed in across restarts while instances stay apart."""
        return "gah_token_" + hashlib.sha256((self.token or "").encode()).hexdigest()[:12]

    def set_token(self, token):
        token = (token or "").strip() or None
        if token is None and not self.loopback_only and not self.allow_no_token:
            raise ValueError("a token is required while the server is reachable from other machines")
        if token is not None and (len(token) < 16 or any(c.isspace() or c in ";,\"" for c in token)):
            raise ValueError("token must be at least 16 characters without spaces, ';', ',' or quotes")
        self.token = token
        return True

    def origin_allowed(self, origin, host_header=None):
        """CSRF gate for POSTs: no Origin (non-browser), the page itself, loopback aliases,
        configured/registered origins, or (wildcard bind) a literal-IP origin matching Host."""
        if origin is None:
            return True
        norm = normalize_origin(origin)
        if norm is None:
            return False
        if norm == normalize_origin(self.url or "") or norm in self.origins():
            return True
        parts = urlsplit(norm)
        host, port = (parts.hostname or "").lower(), parts.port or (443 if parts.scheme == "https" else 80)
        if port != self.bound_port:
            return False
        bind = str(self.host).strip("[]").lower()
        if _is_loopback(host) and (self.loopback_only or bind in WILDCARD_HOSTS):
            return True
        # Literal IPs cannot be DNS-rebound, so a LAN address typed into the browser is safe.
        if bind in WILDCARD_HOSTS or bind == host:
            return _is_ip(host) and normalize_origin(f"{parts.scheme}://{host_header or ''}") == norm
        return False

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



def apply(ctx, config):
    fe = WebFrontend(ctx, config or {})
    ctx.provide("frontend", fe)
    ctx.provide("web.host", fe.web)
    ctx.scope.add(fe.stop)
