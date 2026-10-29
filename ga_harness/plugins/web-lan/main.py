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
import json
import os
import secrets
import socket
import sys
import threading
import time
from pathlib import Path

from ga_harness import paths

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


ANY = "0.0.0.0"  # all interfaces; peers are still filtered by _lan_peer


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


class Forwarder:
    """Accept on ``binds`` (LAN IPs) and pipe each connection to 127.0.0.1:target."""

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
            threading.Thread(target=self._accept, args=(s,), daemon=True, name="gah-lan-accept").start()

    def _accept(self, srv):
        while not self.closed:
            try:
                client, peer = srv.accept()
            except OSError:
                return
            if not _lan_peer(peer[0]):
                client.close()
                continue
            threading.Thread(target=self._serve, args=(client,), daemon=True, name="gah-lan-conn").start()

    def _serve(self, client):
        try:
            upstream = socket.create_connection(("127.0.0.1", self.target), timeout=10)
            upstream.settimeout(None)
        except OSError as e:
            _log(f"[lan] upstream connect failed: {e}")
            client.close()
            return
        with self.lock:
            if self.closed:
                client.close()
                upstream.close()
                return
            self.conns.update((client, upstream))
        t = threading.Thread(target=self._pipe, args=(upstream, client), daemon=True, name="gah-lan-pipe")
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



class Lan:
    def __init__(self, host, config):
        self.host = host
        self.port_setting = int(config.get("port") or 0)
        self.bind_setting = str(config.get("bind") or "").strip()
        self.state_file = paths.home() / "web-lan.json"
        self.lock = threading.RLock()
        self.forwarder = None
        self.undo = []
        self.urls = []
        self.listen_port = 0
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
        with self.lock:
            if self.forwarder:
                return self.snapshot()
            if bind and not self.bind_setting:
                if bind != ANY and bind not in lan_ips():
                    raise ValueError(f"{bind} is not a LAN address of this machine")
                self._save(bind=bind)
            target = self.host.access().get("port")
            if not target:
                raise RuntimeError("web UI is not listening yet")
            st = self.net_status()
            if st["error"]:
                raise RuntimeError(st["error"])
            self.ensure_token()
            port = self.port_setting or target
            if st["binds"] == [ANY] and port == target:
                # A wildcard bind cannot share the port the web UI holds on 127.0.0.1
                # (exclusive bind on Windows, EADDRINUSE on Linux), so step aside by one.
                port = target + 1
            fwd = Forwarder(st["binds"], port, target)
            try:
                fwd.start()
            except OSError as e:
                raise RuntimeError(f"cannot listen on LAN port {port}: {e}") from e
            self.forwarder, self.error, self.listen_port = fwd, "", port
            self.urls = [f"http://{ip}:{port}/" for ip in st["hosts"]]
            self.undo = [self.host.allow_origin(u) for u in self.urls]
            self._save(enabled=True)
            _log(f"[lan] forwarding {', '.join(self.urls)} -> 127.0.0.1:{target}")
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
            _log(f"[lan] autostart failed: {e}")

    def snapshot(self):
        acc = self.host.access()
        with self.lock:
            active, urls, listen = bool(self.forwarder), list(self.urls), self.listen_port
        token = bool(acc.get("token_required"))
        return {"active": active, "urls": urls, "entries": [self.host.entry_url(u) for u in urls] if token else [],
                "error": self.error, "token_required": token, "web_port": acc.get("port"),
                "port": (listen if active else 0) or self.port_setting or acc.get("port"), "enabled": bool(self._load().get("enabled"))}

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
        raise RuntimeError("web-lan needs a ui-web with external-access support (allow_origin)")
    lan = Lan(host, config or {})
    ctx.scope.add(host.register(NAME, script=HERE / "client.js", style=HERE / "client.css", order=60,
                                routes={("GET", ""): lan.status, ("POST", ""): lan.change}))
    ctx.scope.add(lan.close)
    threading.Thread(target=lan.autostart, daemon=True, name="gah-lan-autostart").start()
