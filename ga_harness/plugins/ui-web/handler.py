"""HTTP request handler for ui-web: static page/assets, JSON API, plugin routes and SSE.

Split out of main.py; ``WebFrontend`` sets ``_Handler.frontend`` (via a subclass) before serving.
"""
import hmac
import json
import mimetypes
import os
import queue
import re
import threading
import zlib
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

from ga_harness import uploads

DIST = Path(__file__).with_name("dist")
UNBUILT = ("<!doctype html><meta charset=\"utf-8\"><title>GenericAgent-Harness</title>"
           "<p>Web UI is not built. Run <code>npm install</code> and <code>npm run build</code> in <code>frontend/</code>.</p>")
MAX_BODY = 1 << 20
COOKIE_MAX_AGE = 30 * 24 * 3600  # login cookie lifetime; renewed on each page load

MAX_TOOL_DATA = 20000

# Weak links (remote access over LAN / tailscale / mobile): compress text bodies and let the
# browser revalidate static files instead of downloading ~1 MB of JS/CSS on every page load.
GZIP_MIN = 1024
COMPRESSIBLE = ("text/", "application/json", "image/svg+xml")
IMMUTABLE = "private, max-age=31536000, immutable"   # Vite's content-hashed /assets/*
REVALIDATE = "private, no-cache"                      # cached, but checked via ETag each load
_GZ_CACHE = {}                                        # (path, mtime_ns, size) -> gzip bytes
_GZ_CACHE_MAX = 128
_GZ_LOCK = threading.Lock()


def _gzip(body, level=6):
    c = zlib.compressobj(level, zlib.DEFLATED, 31)   # wbits 31: gzip container
    return c.compress(body) + c.flush()


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
    frontend: "WebFrontend" = None
    protocol_version = "HTTP/1.1"
    # SSE writes many tiny frames; with Nagle on, a frame can wait for the
    # client's (Windows ~200 ms) delayed ACK before leaving, which shows up as
    # bursty streaming. TCP_NODELAY sends each flushed frame immediately.
    disable_nagle_algorithm = True

    def log_message(self, fmt, *args):  # keep the terminal quiet
        pass

    def _accepts_gzip(self):
        for part in (self.headers.get("Accept-Encoding") or "").lower().split(","):
            name, _, params = part.partition(";")
            if name.strip() in ("gzip", "*"):
                q = params.replace(" ", "")
                if q.startswith("q="):
                    try:
                        return float(q[2:]) > 0
                    except ValueError:
                        return False
                return True
        return False

    def _send_body(self, code, body, ctype, cache="no-store", etag=None, gz_key=None, nosniff=False):
        """Send ``body``; gzip it when the client accepts that and it is worth it.

        ``etag`` + a matching If-None-Match gives a bodiless 304. ``gz_key`` caches the
        compressed bytes of an unchanging file so repeated loads cost no CPU.
        """
        compressible = ctype.startswith(COMPRESSIBLE)
        if etag and code == 200 and etag in [t.strip() for t in (self.headers.get("If-None-Match") or "").split(",")]:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache)
            if compressible:
                self.send_header("Vary", "Accept-Encoding")
            self.end_headers()
            return
        encoded = None
        if compressible and len(body) >= GZIP_MIN and self._accepts_gzip():
            with _GZ_LOCK:
                encoded = _GZ_CACHE.get(gz_key) if gz_key else None
            if encoded is None:
                encoded = _gzip(body, 6 if gz_key else 5)
                if gz_key:
                    with _GZ_LOCK:
                        if len(_GZ_CACHE) >= _GZ_CACHE_MAX:
                            _GZ_CACHE.pop(next(iter(_GZ_CACHE)))
                        _GZ_CACHE[gz_key] = encoded
            body = encoded
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if encoded is not None:
            self.send_header("Content-Encoding", "gzip")
        if compressible:
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        if etag:
            self.send_header("ETag", etag)
        if nosniff:
            self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send_body(code, body, "application/json; charset=utf-8")

    def _bytes(self, code, body, ctype):
        self._send_body(code, body, ctype, nosniff=True)

    def _static(self, path, ctype, immutable=False):
        """A file that only changes on rebuild/upgrade: cacheable, validated by mtime+size."""
        st = Path(path).stat()
        etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
        cache = IMMUTABLE if immutable else REVALIDATE
        if etag in [t.strip() for t in (self.headers.get("If-None-Match") or "").split(",")]:
            return self._send_body(200, b"", ctype, cache=cache, etag=etag)   # -> 304
        self._send_body(200, Path(path).read_bytes(), ctype, cache=cache, etag=etag,
                        gz_key=(str(path), st.st_mtime_ns, st.st_size), nosniff=True)

    LOG_NAME = re.compile(r"^[\w.-]+\.log(\.\d+)?$")
    LOG_TAIL = 256 * 1024
    LOG_TAIL_MAX = 4 * 1024 * 1024

    def _logs(self):
        """GET /api/logs: list the program log files; ?name=N[&bytes=B] returns the tail of one.

        Only plain ``*.log`` / ``*.log.N`` files directly inside ``logfile.log_dir()`` are
        served (host.log, worker-*.log, faults.log and the desktop shell's backend.log).
        """
        from ga_harness import logfile
        query = parse_qs(urlsplit(self.path).query)
        try:
            root = logfile.log_dir().resolve()
        except Exception as e:  # noqa: BLE001 - report instead of failing the page
            return self._json(500, {"error": f"log directory unavailable: {e}"})
        name = query.get("name", [""])[0]
        if not name:
            files = []
            try:
                entries = list(root.iterdir()) if root.is_dir() else []
            except OSError as e:
                return self._json(500, {"error": f"cannot list {root}: {e}"})
            for p in entries:
                if not self.LOG_NAME.match(p.name) or not p.is_file():
                    continue
                try:
                    st = p.stat()
                except OSError:
                    continue
                files.append({"name": p.name, "size": st.st_size, "mtime": st.st_mtime})
            files.sort(key=lambda f: -f["mtime"])
            return self._json(200, {"dir": str(root), "files": files})
        if not self.LOG_NAME.match(name):
            return self._json(400, {"error": "invalid log name"})
        target = (root / name).resolve()
        if target.parent != root or not target.is_file():
            return self._json(404, {"error": "log not found"})
        try:
            want = int(query.get("bytes", [str(self.LOG_TAIL)])[0])
        except ValueError:
            want = self.LOG_TAIL
        want = max(1024, min(want, self.LOG_TAIL_MAX))
        try:
            with target.open("rb") as fh:
                size = fh.seek(0, os.SEEK_END)
                start = max(0, size - want)
                fh.seek(start)
                data = fh.read(size - start)
                mtime = os.fstat(fh.fileno()).st_mtime
        except OSError as e:
            return self._json(404, {"error": f"unreadable: {e}"})
        if start:   # drop the partial first line
            cut = data.find(b"\n")
            data = data[cut + 1:] if cut >= 0 else data
        return self._json(200, {"name": name, "path": str(target), "size": size, "mtime": mtime,
                                "truncated": start > 0, "text": data.decode("utf-8", "replace")})

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
        return self.frontend.origin_allowed(self.headers.get("Origin"), self.headers.get("Host"))

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
        if morsel and hmac.compare_digest(morsel.value, token):
            # Sliding expiry: a page load through the cookie pushes it another COOKIE_MAX_AGE out.
            self._renew_cookie = urlsplit(self.path).path in ("/", "/index.html")
            return True
        return False

    def _cookie_header(self):
        token = self.frontend.token
        secure = "; Secure" if (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower() == "https" else ""
        return f"{self.frontend.cookie_name}={token}; Path=/; Max-Age={COOKIE_MAX_AGE}; HttpOnly; SameSite=Strict{secure}"

    def end_headers(self):
        if getattr(self, "_renew_cookie", False):
            self._renew_cookie = False
            self.send_header("Set-Cookie", self._cookie_header())
        super().end_headers()

    def _enter_with_token(self, path):
        """``/?gah_token=X`` -> set the HttpOnly cookie and drop the token from the address bar."""
        token = self.frontend.token
        given = parse_qs(urlsplit(self.path).query).get("gah_token", [""])[0]
        if not (token and given and path in ("/", "/index.html") and hmac.compare_digest(given, token)):
            return False
        self.send_response(303)
        self.send_header("Location", "/")
        self.send_header("Set-Cookie", self._cookie_header())
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
                self._static(asset, types[asset.suffix], immutable=True)
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
                self._static(DIST.with_name(name), assets[name])
            except OSError:
                self._json(404, {"error": "asset unavailable"})
        elif path.startswith("/web/"):
            parts = path.split("/")
            found = len(parts) == 4 and self.frontend.web.asset(parts[2], parts[3])
            if not found:
                return self._json(404, {"error": "not found"})
            try:
                self._static(found[0], found[1])
            except OSError:
                self._json(404, {"error": "asset unavailable"})
        elif path.startswith("/api/p/"):
            self._plugin_route("GET", path, None)
        elif path == "/api/web/plugins":
            self._json(200, self.frontend.web.manifest())
        elif path == "/api/file":
            self._file()
        elif path == "/api/logs":
            self._logs()
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

    def _plugin_import_zip(self, n):
        """Raw zip body; name in X-File-Name, options in the query (replace=1, subdir=...)."""
        from urllib.parse import unquote
        from ga_harness.plugin_import import MAX_ZIP
        if n > MAX_ZIP:
            self.close_connection = True
            return self._json(413, {"error": f"archive exceeds {MAX_ZIP >> 20} MB"})
        if n <= 0:
            return self._json(400, {"error": "empty archive"})
        data = self.rfile.read(n)
        if len(data) != n:
            self.close_connection = True
            return self._json(400, {"error": "incomplete upload"})
        q = parse_qs(urlsplit(self.path).query)
        replace = (q.get("replace") or [""])[0] in ("1", "true", "yes")
        subdir = (q.get("subdir") or [""])[0] or None
        name = unquote(self.headers.get("X-File-Name") or "")
        self._json(*self.frontend.plugin_import(data, filename=name, replace=replace, subdir=subdir))

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
        if path == "/api/plugins/import" and not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self._plugin_import_zip(n)
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
        elif path == "/api/plugins/import":
            self._json(*self.frontend.plugin_import(
                {k: body[k] for k in ("url", "ref", "subdir") if body.get(k)},
                replace=body.get("replace") is True, subdir=body.get("subdir") or None))
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
        elif path == "/api/models/secret":
            self._json(*self.frontend.model_secret(body))
        elif path == "/api/models/test":
            self._json(*self.frontend.model_test(body))
        elif path == "/api/abort":
            self._json(*self.frontend.abort(body))
        else:
            self._json(404, {"error": "not found"})

    def _sse(self):
        fe = self.frontend
        q = queue.Queue()
        # A reconnecting page passes the id of the last event it applied; if the backlog still
        # covers it, replay only the gap. The browser's own Last-Event-ID is ignored on purpose:
        # the page may have reloaded state over HTTP since, and replaying onto that duplicates.
        last = parse_qs(urlsplit(self.path).query).get("last", [""])[0].strip()
        try:
            with fe.lock:  # snapshot + subscribe atomically: no chunk lost or duplicated
                base = fe.subscribe(q, last)
                if base is None:
                    first = "event: resume\ndata: {}\n\n"
                else:
                    first = f"id: {base}\nevent: snapshot\ndata: {json.dumps(fe.snapshot(), ensure_ascii=False)}\n\n"
        except Exception as e:
            with fe._clients_lock:
                fe.clients.discard(q)
            # Previously this escaped as a dropped connection, leaving the page stuck on "Connecting".
            import traceback
            fe.log(f"[web] /api/events snapshot failed: {type(e).__name__}: {e}\n{traceback.format_exc()}")
            return self._json(500, {"error": f"snapshot failed: {type(e).__name__}: {e}"})
        try:
            # The snapshot (whole visible history) is resent on every reconnect, which on a
            # flaky link is the dominant cost; a gzip stream with a sync flush per event cuts
            # it ~4x while each event still reaches the browser immediately.
            gz = zlib.compressobj(5, zlib.DEFLATED, 31) if self._accepts_gzip() else None

            def send(data):
                if gz:
                    data = gz.compress(data) + gz.flush(zlib.Z_SYNC_FLUSH)
                self.wfile.write(data)
                self.wfile.flush()

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store, no-transform")
            self.send_header("X-Accel-Buffering", "no")
            if gz:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            # 2 KiB comment padding: some proxies / AV web shields (common on Windows Server)
            # buffer small streamed responses, so the browser never sees the first event.
            # Compressed, spaces would shrink to a few bytes, so pad with incompressible text.
            pad = os.urandom(1536).hex()[:2048].encode() if gz else b" " * 2048
            send(b":" + pad + b"\n\n")
            send(first.encode("utf-8"))
            while True:
                try:
                    msg = q.get(timeout=15)
                except queue.Empty:
                    msg = "event: ping\ndata: {}\n\n"
                if msg is None:
                    return
                send(msg.encode("utf-8"))
        except OSError:
            pass
        finally:
            with fe._clients_lock:
                fe.clients.discard(q)
