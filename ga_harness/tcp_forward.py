"""Loopback TCP forwarder, a self-healing watchdog and a small JSON state file shared by
the web-lan and web-tailscale plugins.

``Forwarder`` accepts on the given bind addresses and pipes each allowed connection to
``127.0.0.1:target``; peers rejected by ``allow_peer`` are closed immediately. Transient
accept errors are retried; a listener that dies for good marks the forwarder as failed
(``alive()`` turns false) and calls ``on_fail`` so the owner can rebind right away.

``Watchdog`` runs an owner-supplied ``heal()`` on a background thread; ``heal`` returns the
number of seconds until the next check. ``Backoff`` gives capped exponential retry delays.
"""
from __future__ import annotations

import errno
import json
import os
import socket
import sys
import threading
import time


def log(tag, msg):
    print(f"[{tag}] {msg}", file=sys.stderr, flush=True)


# accept() errors that only concern one pending connection or a momentary resource shortage.
_TRANSIENT = {getattr(errno, n) for n in ("ECONNABORTED", "ECONNRESET", "EMFILE", "ENFILE", "ENOBUFS",
                                           "ENOMEM", "EINTR", "EAGAIN", "EWOULDBLOCK", "EPROTO", "EPERM")
              if hasattr(errno, n)} | {10053, 10054, 10055, 10024, 10035}  # WSAE* equivalents


def tune(sock):
    """Low latency + TCP keepalive so silently vanished peers (sleeping phone, NAT/DERP drop)
    are noticed in ~1 minute instead of pinning a pipe thread forever."""
    for level, opt, val in ((socket.IPPROTO_TCP, socket.TCP_NODELAY, 1), (socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)):
        try:
            sock.setsockopt(level, opt, val)
        except OSError:
            pass
    try:
        if hasattr(socket, "SIO_KEEPALIVE_VALS"):
            sock.ioctl(socket.SIO_KEEPALIVE_VALS, (1, 30_000, 10_000))  # idle 30s, probe every 10s
        else:
            for name, val in (("TCP_KEEPIDLE", 30), ("TCP_KEEPALIVE", 30), ("TCP_KEEPINTVL", 10), ("TCP_KEEPCNT", 4)):
                if hasattr(socket, name):
                    sock.setsockopt(socket.IPPROTO_TCP, getattr(socket, name), val)
    except (OSError, ValueError):
        pass


class Forwarder:
    """Accept on ``binds`` and pipe each connection from an allowed peer to 127.0.0.1:target."""

    def __init__(self, binds, port, target, allow_peer, tag="fwd", on_fail=None):
        self.binds, self.port, self.target = binds, port, target
        self.allow_peer, self.tag, self.on_fail = allow_peer, tag, on_fail
        self.socks, self.conns = [], set()
        self.lock = threading.Lock()
        self.closed = False
        self.failed = ""

    def start(self):
        try:
            for ip in self.binds:
                fam = socket.AF_INET6 if ":" in ip else socket.AF_INET
                s = socket.socket(fam, socket.SOCK_STREAM)
                if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                elif os.name != "nt":
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)  # quick rebind after a drop
                self.socks.append(s)
                s.bind((ip, self.port))
                s.listen(128)
        except OSError:
            self.close()
            raise
        for s in self.socks:
            threading.Thread(target=self._accept, args=(s,), daemon=True, name=f"gah-{self.tag}-accept").start()

    def alive(self):
        return not self.closed and not self.failed

    def probe(self, host, timeout=3.0):
        """Connect to our own listener (e.g. this machine's tailnet/LAN IP); True if it answers."""
        try:
            with socket.create_connection((host.strip("[]"), self.port), timeout=timeout):
                return True
        except OSError:
            return False

    def _fail(self, why):
        if self.closed or self.failed:
            return
        self.failed = why
        log(self.tag, f"listener failed: {why}")
        if self.on_fail:
            try:
                self.on_fail()
            except Exception:
                pass

    def _accept(self, srv):
        errors = 0
        while not self.closed:
            try:
                client, peer = srv.accept()
            except OSError as e:
                if self.closed:
                    return
                code = getattr(e, "winerror", None) or e.errno
                if code in _TRANSIENT and errors < 50:
                    errors += 1
                    time.sleep(min(1.0, 0.02 * 2 ** min(errors, 6)))
                    continue
                self._fail(f"accept on port {self.port}: {e}")
                return
            errors = 0
            try:
                if not self.allow_peer(peer[0]):
                    client.close()
                    continue
                threading.Thread(target=self._serve, args=(client,), daemon=True, name=f"gah-{self.tag}-conn").start()
            except Exception as e:  # never let one bad connection kill the listener
                log(self.tag, f"dropping connection from {peer[0]}: {e}")
                try:
                    client.close()
                except OSError:
                    pass

    def _serve(self, client):
        tune(client)
        upstream = None
        for attempt in range(3):  # the web UI may be briefly busy/restarting its listener
            try:
                upstream = socket.create_connection(("127.0.0.1", self.target), timeout=10)
                break
            except OSError as e:
                if attempt == 2 or self.closed:
                    log(self.tag, f"upstream connect failed: {e}")
                    client.close()
                    return
                time.sleep(0.3 * (attempt + 1))
        upstream.settimeout(None)
        try:
            upstream.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        with self.lock:
            if self.closed:
                client.close()
                upstream.close()
                return
            self.conns.update((client, upstream))
        t = threading.Thread(target=self._pipe, args=(upstream, client), daemon=True, name=f"gah-{self.tag}-pipe")
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
            # Reset/timeout on either side: tear both down so the opposite pipe thread wakes
            # up instead of blocking forever on a half-dead connection.
            for s in (src, dst):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            return
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


class Backoff:
    """Capped exponential delays: 2, 4, 8, ... up to ``cap`` seconds."""

    def __init__(self, base=2.0, cap=60.0):
        self.base, self.cap, self.fails = base, cap, 0

    def next(self):
        delay = min(self.cap, self.base * 2 ** min(self.fails, 10))
        self.fails += 1
        return delay

    def reset(self):
        self.fails = 0


class Watchdog:
    """Run ``heal()`` repeatedly on a daemon thread; it returns seconds until the next run.
    ``kick()`` runs it again right away (e.g. a listener just failed or the user pressed start)."""

    def __init__(self, heal, tag):
        self.heal, self.tag = heal, tag
        self.wake = threading.Event()
        self.stopped = False
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self._run, daemon=True, name=f"gah-{self.tag}-watchdog")
        self.thread.start()
        return self

    def kick(self):
        self.wake.set()

    def stop(self):
        self.stopped = True
        self.wake.set()

    def _run(self):
        while not self.stopped:
            try:
                delay = self.heal()
            except Exception as e:  # keep watching even if one check blows up
                log(self.tag, f"watchdog error: {type(e).__name__}: {e}")
                delay = 15
            if self.stopped:
                return
            before = time.time()
            self.wake.wait(max(0.2, float(delay or 15)))
            self.wake.clear()
            if time.time() - before > (delay or 15) + 30:
                log(self.tag, "clock jumped (sleep/resume?); re-checking")


def load_state(path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(path, **changes):
    """Merge ``changes`` into the JSON file atomically (owner-only on POSIX: it holds a token)."""
    data = {**load_state(path), **changes}
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    if os.name != "nt":
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)
