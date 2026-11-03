"""web-tailscale: reach the local web UI from other devices on a Tailscale/Headscale tailnet.

No ``tailscale serve`` (Headscale often has no HTTPS certs, and serve config is global and
outlives this process). Instead a small TCP forwarder listens on this machine's tailnet IPs
only and pipes to the loopback web server, so nothing is exposed on LAN or the internet.

Safety: forwarding never starts without an access token. If ui-web runs without one, a
random token is generated, applied with ``web.host.set_token`` and persisted (state file in
the ga-harness home) so it survives restarts. The tailnet origins are registered with
``web.host.allow_origin`` so browser POSTs pass the CSRF gate, and withdrawn on stop.

Self-healing: while forwarding is enabled a watchdog re-checks every few seconds. When
tailscale disconnects/reconnects, the tailnet IPs or the web UI port change, the machine
wakes from sleep, or the listener dies or stops answering, the forwarder is rebuilt; failed
attempts are retried with capped exponential backoff instead of giving up after one try.

Routes: GET /api/p/web-tailscale/ -> status; POST with {"action": start|stop|reset_token|status}.
"""
from __future__ import annotations

import ipaddress
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from ga_harness import paths
from ga_harness.tcp_forward import Backoff, Forwarder, Watchdog, load_state, save_state

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
CHECK_EVERY = 10  # seconds between health checks while forwarding is healthy


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
        self._bind_error = None
        self.bound = None  # (ips, target) the current forwarder was built for
        self.backoff = Backoff(base=2, cap=60)
        self.retry_at = 0.0
        self.restarts = 0
        self.last_ok = 0.0
        self.watchdog = Watchdog(self.heal, "tailscale")

    # ---- persisted state (token + enabled flag) ----
    def _load(self):
        return load_state(self.state_file)

    def _save(self, **changes):
        save_state(self.state_file, **changes)

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
        """User-requested start: remember the wish (so the watchdog keeps it alive) and try now."""
        self._save(enabled=True)
        try:
            return self._ensure()
        finally:
            self.watchdog.kick()

    def _ensure(self, st=None):
        """Bring the forwarder in line with the current tailnet IPs / web UI port. Raises on failure."""
        with self.lock:
            target = self.host.access().get("port")
            if not target:
                raise RuntimeError("web UI is not listening yet")
            st = st or self.ts_status()
            if not st.get("running"):
                raise RuntimeError(st.get("error") or "tailscale is not running")
            want = (tuple(sorted(st["ips"])), target, st.get("dns") or "")
            if self.forwarder and self.forwarder.alive() and self.bound == want:
                return self.snapshot()
            if self.forwarder:
                why = "listener died" if not self.forwarder.alive() else "tailnet address / web port changed"
                _log(f"[tailscale] rebuilding forwarder: {why}")
                self._teardown()
                self.restarts += 1
            self.ensure_token()
            port = self.port_setting
            if not 0 < port < 65536:
                raise ValueError("set the tailnet port (1-65535) in the plugin settings")
            if port == target:
                raise ValueError(f"port {port} is the local web UI port; choose another one")
            v4 = [ip for ip in st["ips"] if ":" not in ip]
            v6 = [ip for ip in st["ips"] if ":" in ip]
            fwd = self._listen(v4 + v6, port, target)
            if fwd is None:
                if not v4:
                    raise RuntimeError(f"cannot listen on tailnet port {port}")
                fwd = self._listen(v4, port, target)  # IPv6 bind can fail on some stacks; v4 is enough
                if fwd is None:
                    raise RuntimeError(f"cannot listen on tailnet port {port}: {self._bind_error}")
                v6 = []
            hosts = v4 + ([st["dns"]] if st.get("dns") else []) + [f"[{ip}]" for ip in v6]
            self.forwarder, self.bound, self.error = fwd, want, ""
            self.urls = [f"http://{h}:{port}/" for h in hosts]
            self.undo = [self.host.allow_origin(u) for u in self.urls]
            self.backoff.reset()
            self.retry_at, self.last_ok = 0.0, time.time()
            _log(f"[tailscale] forwarding {', '.join(self.urls)} -> 127.0.0.1:{target}")
            return self.snapshot()

    def _listen(self, binds, port, target):
        # The old listener may linger for a moment after a network change; retry the bind briefly.
        for attempt in range(4):
            fwd = Forwarder(binds, port, target, _tailnet, "ts", on_fail=self.watchdog.kick)
            try:
                fwd.start()
                return fwd
            except OSError as e:
                self._bind_error = e
                time.sleep(0.5 * (attempt + 1))
        return None

    def _teardown(self):
        fwd, undo = self.forwarder, self.undo
        self.forwarder, self.undo, self.urls, self.bound = None, [], [], None
        if fwd:
            fwd.close()
        for u in undo:
            try:
                u()
            except Exception:
                pass

    def heal(self):
        """Watchdog step: keep forwarding up while enabled. Returns seconds until the next check."""
        if self.stopped:
            return CHECK_EVERY
        if not self._load().get("enabled"):
            with self.lock:
                if self.forwarder:
                    self._teardown()
            return 30
        if not self.host.access().get("port"):
            return 1
        now = time.time()
        with self.lock:
            healthy = bool(self.forwarder and self.forwarder.alive())
        if not healthy and now < self.retry_at:
            return max(0.5, self.retry_at - now)
        st = self.ts_status()
        try:
            if not st.get("running"):
                raise RuntimeError((st.get("error") or "tailscale is not running") + "; waiting to reconnect")
            self._ensure(st)
            with self.lock:
                fwd, ips = self.forwarder, [ip for ip in st["ips"] if ":" not in ip]
            if fwd and ips and not fwd.probe(ips[0]):
                # Listener looks alive but our own tailnet IP cannot reach it: rebuild.
                _log("[tailscale] self-probe failed; rebuilding forwarder")
                with self.lock:
                    self._teardown()
                self.restarts += 1
                self._ensure(st)
            self.last_ok = time.time()
            return CHECK_EVERY
        except ValueError as e:  # configuration problem: retrying will not help until settings change
            self.error = str(e)
            return 60
        except Exception as e:
            with self.lock:
                if self.forwarder and not st.get("running"):
                    self._teardown()  # the tailnet IPs are gone; drop stale listeners/origins
            delay = self.backoff.next()
            self.retry_at = time.time() + delay
            if self.error != str(e):
                _log(f"[tailscale] {e}; retrying in {delay:.0f}s")
            self.error = str(e)
            return delay

    def stop(self, persist=True):
        with self.lock:
            self._teardown()
            if persist:
                self._save(enabled=False)
                self.error = ""
                self.backoff.reset()
                self.retry_at = 0.0
            return self.snapshot()

    def reset_token(self):
        token = _new_token()
        self.host.set_token(token)
        self._save(token=token)
        return self.snapshot()

    def autostart(self):
        """Resume forwarding after a restart if it was left enabled; the watchdog does the work."""
        self.watchdog.start()

    def snapshot(self):
        acc = self.host.access()
        with self.lock:
            active = bool(self.forwarder and self.forwarder.alive())
            urls = list(self.urls) if active else []
        token = bool(acc.get("token_required"))
        enabled = bool(self._load().get("enabled"))
        wait = max(0, round(self.retry_at - time.time())) if enabled and not active and self.retry_at else 0
        return {"active": active, "urls": urls, "entries": [self.host.entry_url(u) for u in urls] if token else [],
                "error": self.error if not active else "", "token_required": token, "web_port": acc.get("port"),
                "port": self.port_setting, "enabled": enabled, "reconnecting": enabled and not active,
                "retry_in": wait, "restarts": self.restarts}

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
        except ValueError as e:
            self.error = str(e)
            self._save(enabled=False)  # bad settings: do not keep retrying in the background
            return 400, {"error": str(e)}
        except RuntimeError as e:
            # Remembered as enabled: the watchdog keeps retrying (e.g. until tailscale connects).
            self.error = str(e)
            return 400, {"error": f"{e} (will keep retrying automatically)"}
        return self.status()

    def close(self):
        self.stopped = True
        self.watchdog.stop()
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
