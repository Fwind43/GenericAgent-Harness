"""web-tailscale: reach the local web UI from other devices on a Tailscale/Headscale tailnet.

No ``tailscale serve`` (Headscale often has no HTTPS certs, and serve config is global and
outlives this process). Instead a small TCP forwarder listens on this machine's tailnet IPs
only and pipes to the loopback web server, so nothing is exposed on LAN or the internet.

Safety: forwarding never starts without an access token. If ui-web runs without one, a
random token is generated, applied with ``web.host.set_token`` and persisted (state file in
the ga-harness home) so it survives restarts. The tailnet origins are registered with
``web.host.allow_origin`` so browser POSTs pass the CSRF gate, and withdrawn on stop.

Routes: GET /api/p/web-tailscale/ -> status; POST with {"action": start|stop|reset_token|status}.
"""
from __future__ import annotations

import ipaddress
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

from ga_harness import paths

HERE = Path(__file__).resolve().parent
NAME = "web-tailscale"
WIN_DEFAULT = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Tailscale" / "tailscale.exe"
TAILNET_V4 = ipaddress.ip_network("100.64.0.0/10")
TAILNET_V6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")


def _new_token():
    return secrets.token_urlsafe(24)


def _log(msg):
    print(msg, file=sys.stderr, flush=True)


def _tailnet(ip):
    try:
        addr = ipaddress.ip_address(str(ip).split("%", 1)[0])
    except ValueError:
        return False
    if addr.version == 6 and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr in (TAILNET_V4 if addr.version == 4 else TAILNET_V6)


DEFAULT_PORT = 8766  # user-facing tailnet port; the web UI itself stays on 127.0.0.1:<random>


class Forwarder:
    """Accept on ``binds`` (tailnet IPs) and pipe each connection to 127.0.0.1:target."""

    def __init__(self, binds, port, target):
        self.binds, self.port, self.target = binds, port, target
        self.socks, self.conns = [], set()
        self.lock = threading.Lock()
        self.closed = False

    def start(self):
        try:
            for ip in self.binds:
                fam = socket.AF_INET6 if ":" in ip else socket.AF_INET
                s = socket.socket(fam, socket.SOCK_STREAM)
                if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                self.socks.append(s)
                s.bind((ip, self.port))
                s.listen(64)
        except OSError:
            self.close()
            raise
        for s in self.socks:
            threading.Thread(target=self._accept, args=(s,), daemon=True, name="gah-ts-accept").start()

    def _accept(self, srv):
        while not self.closed:
            try:
                client, peer = srv.accept()
            except OSError:
                return
            if not _tailnet(peer[0]):
                client.close()
                continue
            threading.Thread(target=self._serve, args=(client,), daemon=True, name="gah-ts-conn").start()

    def _serve(self, client):
        try:
            upstream = socket.create_connection(("127.0.0.1", self.target), timeout=10)
            upstream.settimeout(None)
        except OSError as e:
            _log(f"[tailscale] upstream connect failed: {e}")
            client.close()
            return
        with self.lock:
            if self.closed:
                client.close()
                upstream.close()
                return
            self.conns.update((client, upstream))
        t = threading.Thread(target=self._pipe, args=(upstream, client), daemon=True, name="gah-ts-pipe")
        t.start()
        self._pipe(client, upstream)
        t.join()
        with self.lock:
            self.conns.discard(client)
            self.conns.discard(upstream)
        for s in (client, upstream):
            try:
                s.close()
            except OSError:
                pass

    @staticmethod
    def _pipe(src, dst):
        try:
            while True:
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except OSError:
            pass
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    def close(self):
        with self.lock:
            self.closed = True
            items = list(self.socks) + list(self.conns)
            self.socks, self.conns = [], set()
        for s in items:
            try:
                s.close()
            except OSError:
                pass


class Tailscale:
    def __init__(self, host, config):
        self.host = host
        self.port_setting = int(config.get("port") or DEFAULT_PORT)
        self.exe_setting = str(config.get("tailscale_path") or "").strip()
        self.state_file = paths.home() / "web-tailscale.json"
        self.lock = threading.RLock()
        self.forwarder = None
        self.undo = []
        self.urls = []
        self.error = ""
        self.stopped = False

    # ---- persisted state (token + enabled flag) ----
    def _load(self):
        try:
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self, **changes):
        data = {**self._load(), **changes}
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_file.with_name(self.state_file.name + ".tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        if os.name != "nt":
            os.chmod(tmp, 0o600)
        os.replace(tmp, self.state_file)

    # ---- tailscale cli ----
    def exe(self):
        for cand in (self.exe_setting, shutil.which("tailscale"), str(WIN_DEFAULT) if os.name == "nt" else ""):
            if cand and Path(cand).is_file():
                return cand
        return None

    def ts_status(self):
        exe = self.exe()
        if not exe:
            return {"installed": False, "running": False, "ips": [], "error": "tailscale executable not found"}
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            out = subprocess.run([exe, "status", "--json"], capture_output=True, timeout=10, creationflags=flags)
            data = json.loads(out.stdout.decode("utf-8", "replace") or "{}")
        except (OSError, subprocess.TimeoutExpired, ValueError) as e:
            return {"installed": True, "running": False, "ips": [], "error": f"tailscale status failed: {e}"}
        me = data.get("Self") or {}
        ips = [ip for ip in (data.get("TailscaleIPs") or me.get("TailscaleIPs") or []) if _tailnet(ip)]
        state = data.get("BackendState") or ""
        running = state == "Running" and bool(ips)
        return {"installed": True, "running": running, "backend": state, "ips": ips,
                "dns": (me.get("DNSName") or "").rstrip("."), "hostname": me.get("HostName") or "",
                "error": "" if running else f"tailscale is {state or 'not running'}"}

    # ---- lifecycle ----
    def ensure_token(self):
        """Make sure ui-web requires a token; reuse the persisted one or generate it."""
        if self.host.access().get("token_required"):
            return False
        token = self._load().get("token") or _new_token()
        self.host.set_token(token)
        self._save(token=token)
        return True

    def start(self):
        with self.lock:
            if self.forwarder:
                return self.snapshot()
            target = self.host.access().get("port")
            if not target:
                raise RuntimeError("web UI is not listening yet")
            st = self.ts_status()
            if not st.get("running"):
                raise RuntimeError(st.get("error") or "tailscale is not running")
            self.ensure_token()
            port = self.port_setting
            if not 0 < port < 65536:
                raise ValueError("set the tailnet port (1-65535) in the plugin settings")
            if port == target:
                raise ValueError(f"port {port} is the local web UI port; choose another one")
            v4 = [ip for ip in st["ips"] if ":" not in ip]
            v6 = [ip for ip in st["ips"] if ":" in ip]
            fwd = Forwarder(v4 + v6, port, target)
            try:
                fwd.start()
            except OSError as e:
                if not v4:
                    raise RuntimeError(f"cannot listen on tailnet port {port}: {e}") from e
                fwd = Forwarder(v4, port, target)  # IPv6 bind can fail on some stacks; v4 is enough
                try:
                    fwd.start()
                except OSError as e2:
                    raise RuntimeError(f"cannot listen on tailnet port {port}: {e2}") from e2
                v6 = []
            hosts = v4 + ([st["dns"]] if st.get("dns") else []) + [f"[{ip}]" for ip in v6]
            self.forwarder, self.error = fwd, ""
            self.urls = [f"http://{h}:{port}/" for h in hosts]
            self.undo = [self.host.allow_origin(u) for u in self.urls]
            self._save(enabled=True)
            _log(f"[tailscale] forwarding {', '.join(self.urls)} -> 127.0.0.1:{target}")
            return self.snapshot()

    def stop(self, persist=True):
        with self.lock:
            fwd, undo = self.forwarder, self.undo
            self.forwarder, self.undo, self.urls = None, [], []
            if fwd:
                fwd.close()
            for u in undo:
                try:
                    u()
                except Exception:
                    pass
            if persist:
                self._save(enabled=False)
                self.error = ""
            return self.snapshot()

    def reset_token(self):
        token = _new_token()
        self.host.set_token(token)
        self._save(token=token)
        return self.snapshot()

    def autostart(self):
        """Resume forwarding after a restart if it was left enabled."""
        if not self._load().get("enabled"):
            return
        deadline = time.time() + 60
        while not self.stopped and time.time() < deadline and not self.host.access().get("port"):
            time.sleep(0.5)
        if self.stopped:
            return
        try:
            self.start()
        except Exception as e:
            self.error = str(e)
            _log(f"[tailscale] autostart failed: {e}")

    def snapshot(self):
        acc = self.host.access()
        with self.lock:
            active, urls = bool(self.forwarder), list(self.urls)
        token = bool(acc.get("token_required"))
        return {"active": active, "urls": urls, "entries": [self.host.entry_url(u) for u in urls] if token else [],
                "error": self.error, "token_required": token, "web_port": acc.get("port"),
                "port": self.port_setting, "enabled": bool(self._load().get("enabled"))}

    def status(self, req=None):
        return {**self.snapshot(), "tailscale": self.ts_status()}

    def change(self, req):
        action = ((req or {}).get("body") or {}).get("action") or "status"
        try:
            if action == "start":
                self.start()
            elif action == "stop":
                self.stop()
            elif action == "reset_token":
                self.reset_token()
            elif action != "status":
                return 400, {"error": f"unknown action: {action}"}
        except (RuntimeError, ValueError) as e:
            self.error = str(e)
            return 400, {"error": str(e)}
        return self.status()

    def close(self):
        self.stopped = True
        self.stop(persist=False)


def apply(ctx, config):
    host = ctx.get("web.host")
    if not hasattr(host, "allow_origin"):
        raise RuntimeError("web-tailscale needs a ui-web with external-access support (allow_origin)")
    ts = Tailscale(host, config or {})
    ctx.scope.add(host.register(NAME, script=HERE / "client.js", style=HERE / "client.css", order=60,
                                routes={("GET", ""): ts.status, ("POST", ""): ts.change}))
    ctx.scope.add(ts.close)
    threading.Thread(target=ts.autostart, daemon=True, name="gah-ts-autostart").start()
