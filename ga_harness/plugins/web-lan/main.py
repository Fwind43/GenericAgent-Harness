"""web-lan: reach the local web UI from phones/computers on the same local network.

ui-web stays on loopback. A small TCP forwarder listens on the chosen LAN IPv4 address(es)
only and pipes to 127.0.0.1; connections from non-private peers are dropped.

Safety: forwarding never starts without an access token (generated and persisted in the
ga-harness home when ui-web has none, applied via ``web.host.set_token``). LAN origins are
registered with ``web.host.allow_origin`` and withdrawn on stop. Plain HTTP: anyone on the
same network who can sniff traffic can see the token, so only use trusted networks.

Routes: GET /api/p/web-lan/ -> status; POST with {"action": start|stop|reset_token|status}
(start accepts an optional "bind" picked from the listed LAN IPs; it is remembered).
"""
from __future__ import annotations

import ipaddress
import secrets
import socket
import sys
import threading
import time
from pathlib import Path

from ga_harness import paths
from ga_harness.tcp_forward import Backoff, Forwarder, Watchdog, load_state, save_state

HERE = Path(__file__).resolve().parent
NAME = "web-lan"
# Ranges that look private but are not a real LAN: tailnet CGNAT, Clash/benchmark fake-IP.
NOT_LAN = [ipaddress.ip_network(n) for n in ("100.64.0.0/10", "198.18.0.0/15")]


def _new_token():
    return secrets.token_urlsafe(24)


def _log(msg):
    print(msg, file=sys.stderr, flush=True)


def _addr(ip):
    try:
        addr = ipaddress.ip_address(str(ip).split("%", 1)[0])
    except ValueError:
        return None
    if addr.version == 6 and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr


DEFAULT_PORT = 8765  # user-facing LAN port; the web UI itself stays on 127.0.0.1:<random>
ANY = "0.0.0.0"  # all interfaces; peers are still filtered by _lan_peer
CHECK_EVERY = 10  # seconds between health checks while forwarding is healthy


def _lan_ip(ip):
    """Usable LAN IPv4 of this machine: private, not loopback/link-local/tailnet/fake-IP."""
    a = _addr(ip)
    return bool(a and a.version == 4 and a.is_private and not a.is_loopback and not a.is_link_local
                and not any(a in n for n in NOT_LAN))


def _lan_peer(ip):
    """Peers allowed through the forwarder: private or link-local, never tailnet/fake-IP."""
    a = _addr(ip)
    return bool(a and (a.is_private or a.is_link_local) and not a.is_loopback
                and not any(a in n for n in NOT_LAN if n.version == a.version))


def _primary_ip():
    """IPv4 the OS would use for the default route (no packet is sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))
        return s.getsockname()[0]
    except OSError:
        return ""
    finally:
        s.close()


def lan_ips():
    """LAN IPv4 addresses, default-route one first."""
    found = []
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except OSError:
        infos = []
    for cand in [_primary_ip()] + [i[4][0] for i in infos]:
        if cand and _lan_ip(cand) and cand not in found:
            found.append(cand)
    return found


class Lan:
    def __init__(self, host, config):
        self.host = host
        self.port_setting = int(config.get("port") or DEFAULT_PORT)
        self.bind_setting = str(config.get("bind") or "").strip()
        self.state_file = paths.home() / "web-lan.json"
        self.lock = threading.RLock()
        self.forwarder = None
        self.undo = []
        self.urls = []
        self.listen_port = 0
        self.error = ""
        self.stopped = False
        self.bound = None  # (binds, hosts, target) the current forwarder was built for
        self.backoff = Backoff(base=2, cap=60)
        self.retry_at = 0.0
        self.restarts = 0
        self.watchdog = Watchdog(self.heal, "lan")

    # ---- persisted state (token + enabled flag) ----
    def _load(self):
        return load_state(self.state_file)

    def _save(self, **changes):
        save_state(self.state_file, **changes)

    def net_status(self):
        ips = lan_ips()
        saved = self._load().get("bind")
        pick = self.bind_setting or (saved if saved in ips or saved == ANY else "")
        binds = [pick] if pick else ips[:1]
        error = ""
        if self.bind_setting and not (_lan_ip(self.bind_setting) or self.bind_setting == ANY):
            error = f"bind address {self.bind_setting} is not a private LAN IPv4 or {ANY}"
        elif not binds or not ips:
            error = "no LAN IPv4 address found"
        # Hosts for entry links: every LAN IP when listening on all interfaces.
        hosts = ips if binds == [ANY] else binds
        return {"ips": ips, "binds": [] if error else binds, "hosts": [] if error else hosts,
                "fixed": bool(self.bind_setting), "hostname": socket.gethostname(), "error": error}

    # ---- lifecycle ----
    def ensure_token(self):
        """Make sure ui-web requires a token; reuse the persisted one or generate it."""
        if self.host.access().get("token_required"):
            return False
        token = self._load().get("token") or _new_token()
        self.host.set_token(token)
        self._save(token=token)
        return True

    def start(self, bind=""):
        """User-requested start: remember the wish (so the watchdog keeps it alive) and try now."""
        if bind and not self.bind_setting:
            if bind != ANY and bind not in lan_ips():
                raise ValueError(f"{bind} is not a LAN address of this machine")
            self._save(bind=bind)
        self._save(enabled=True)
        try:
            return self._ensure()
        finally:
            self.watchdog.kick()

    def _ensure(self):
        """Bring the forwarder in line with the current LAN addresses / web UI port. Raises on failure."""
        with self.lock:
            target = self.host.access().get("port")
            if not target:
                raise RuntimeError("web UI is not listening yet")
            st = self.net_status()
            if st["error"]:
                raise RuntimeError(st["error"])
            want = (tuple(st["binds"]), tuple(st["hosts"]), target)
            if self.forwarder and self.forwarder.alive() and self.bound == want:
                return self.snapshot()
            if self.forwarder:
                why = "listener died" if not self.forwarder.alive() else "LAN address / web port changed"
                _log(f"[lan] rebuilding forwarder: {why}")
                self._teardown()
                self.restarts += 1
            self.ensure_token()
            port = self.port_setting
            if not 0 < port < 65536:
                raise ValueError("set the LAN port (1-65535) in the plugin settings")
            if port == target:
                raise ValueError(f"port {port} is the local web UI port; choose another one")
            fwd, err = None, None
            for attempt in range(4):  # the old listener may linger briefly after a network change
                fwd = Forwarder(st["binds"], port, target, _lan_peer, "lan", on_fail=self.watchdog.kick)
                try:
                    fwd.start()
                    break
                except OSError as e:
                    fwd, err = None, e
                    time.sleep(0.5 * (attempt + 1))
            if fwd is None:
                raise RuntimeError(f"cannot listen on LAN port {port}: {err}")
            self.forwarder, self.error, self.listen_port, self.bound = fwd, "", port, want
            self.urls = [f"http://{ip}:{port}/" for ip in st["hosts"]]
            self.undo = [self.host.allow_origin(u) for u in self.urls]
            self.backoff.reset()
            self.retry_at = 0.0
            _log(f"[lan] forwarding {', '.join(self.urls)} -> 127.0.0.1:{target}")
            return self.snapshot()

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
        with self.lock:
            healthy = bool(self.forwarder and self.forwarder.alive())
        if not healthy and time.time() < self.retry_at:
            return max(0.5, self.retry_at - time.time())
        try:
            self._ensure()
            with self.lock:
                fwd, hosts = self.forwarder, list(self.bound[1]) if self.bound else []
            if fwd and hosts and not fwd.probe(hosts[0]):
                _log("[lan] self-probe failed; rebuilding forwarder")
                with self.lock:
                    self._teardown()
                self.restarts += 1
                self._ensure()
            return CHECK_EVERY
        except ValueError as e:  # configuration problem: retrying will not help until settings change
            self.error = str(e)
            return 60
        except Exception as e:
            with self.lock:
                if self.forwarder:
                    self._teardown()  # addresses are gone (e.g. Wi-Fi dropped): drop stale listeners/origins
            delay = self.backoff.next()
            self.retry_at = time.time() + delay
            if self.error != str(e):
                _log(f"[lan] {e}; retrying in {delay:.0f}s")
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
            urls, listen = (list(self.urls) if active else []), self.listen_port
        token = bool(acc.get("token_required"))
        enabled = bool(self._load().get("enabled"))
        wait = max(0, round(self.retry_at - time.time())) if enabled and not active and self.retry_at else 0
        return {"active": active, "urls": urls, "entries": [self.host.entry_url(u) for u in urls] if token else [],
                "error": self.error if not active else "", "token_required": token, "web_port": acc.get("port"),
                "port": (listen if active else 0) or self.port_setting, "enabled": enabled,
                "reconnecting": enabled and not active, "retry_in": wait, "restarts": self.restarts}

    def status(self, req=None):
        return {**self.snapshot(), "lan": self.net_status()}

    def change(self, req):
        body = (req or {}).get("body") or {}
        action = body.get("action") or "status"
        try:
            if action == "start":
                self.start(str(body.get("bind") or "").strip())
            elif action == "stop":
                self.stop()
            elif action == "reset_token":
                self.reset_token()
            elif action != "status":
                return 400, {"error": f"unknown action: {action}"}
        except ValueError as e:
            self.error = str(e)
            if action == "start":
                self._save(enabled=False)  # bad settings: do not keep retrying in the background
            return 400, {"error": str(e)}
        except RuntimeError as e:
            # Remembered as enabled: the watchdog keeps retrying (e.g. until the network is back).
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
        raise RuntimeError("web-lan needs a ui-web with external-access support (allow_origin)")
    lan = Lan(host, config or {})
    ctx.scope.add(host.register(NAME, script=HERE / "client.js", style=HERE / "client.css", order=60,
                                routes={("GET", ""): lan.status, ("POST", ""): lan.change}))
    ctx.scope.add(lan.close)
    threading.Thread(target=lan.autostart, daemon=True, name="gah-lan-autostart").start()
