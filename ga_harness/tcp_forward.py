"""Loopback TCP forwarder and small JSON state file shared by the web-lan and
web-tailscale plugins.

``Forwarder`` accepts on the given bind addresses and pipes each allowed connection to
``127.0.0.1:target``; peers rejected by ``allow_peer`` are closed immediately.
"""
from __future__ import annotations

import json
import os
import socket
import sys
import threading


def log(tag, msg):
    print(f"[{tag}] {msg}", file=sys.stderr, flush=True)


class Forwarder:
    """Accept on ``binds`` and pipe each connection from an allowed peer to 127.0.0.1:target."""

    def __init__(self, binds, port, target, allow_peer, tag="fwd"):
        self.binds, self.port, self.target = binds, port, target
        self.allow_peer, self.tag = allow_peer, tag
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
            threading.Thread(target=self._accept, args=(s,), daemon=True, name=f"gah-{self.tag}-accept").start()

    def _accept(self, srv):
        while not self.closed:
            try:
                client, peer = srv.accept()
            except OSError:
                return
            if not self.allow_peer(peer[0]):
                client.close()
                continue
            threading.Thread(target=self._serve, args=(client,), daemon=True, name=f"gah-{self.tag}-conn").start()

    def _serve(self, client):
        try:
            upstream = socket.create_connection(("127.0.0.1", self.target), timeout=10)
            upstream.settimeout(None)
        except OSError as e:
            log(self.tag, f"upstream connect failed: {e}")
            client.close()
            return
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
