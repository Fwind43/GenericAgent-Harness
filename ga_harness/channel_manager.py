"""Managed channel instances on top of the channels hub.

A *provider* (e.g. ``feishu``) describes a platform: its config fields and a
factory that builds an :class:`~ga_harness.channels.Adapter` from one channel
config. A *channel* is a user-created instance of a provider, persisted in
``channels.json`` and started/stopped independently. Secret fields are
write-only: the API never returns them, an empty value on update keeps the
stored one, and a value of the form ``env:NAME`` is resolved from the
environment at start time.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from collections import deque
from pathlib import Path

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


class ChannelStore:
    """JSON file holding channel configs: {"channels": [{id, provider, ...}]}."""

    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()

    def load(self):
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        items = data.get("channels") if isinstance(data, dict) else None
        return [c for c in items or [] if isinstance(c, dict) and c.get("id")]

    def save(self, channels):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"channels": channels}, ensure_ascii=False, indent=2),
                       encoding="utf-8")
        os.replace(tmp, self.path)


class Provider:
    """Platform description registered by an adapter plugin.

    ``fields``: list of {key, label, label_zh?, secret?, required?, default?}.
    ``factory(channel_id, config, log)`` returns an Adapter named
    ``channel_id``; ``log(level, text)`` appends to the channel log.
    """

    def __init__(self, kind, factory, *, label=None, label_zh=None, fields=()):
        if not ID_RE.match(kind or ""):
            raise ValueError(f"invalid provider kind: {kind!r}")
        self.kind, self.factory = kind, factory
        self.label, self.label_zh = label or kind, label_zh or label or kind
        self.fields = [dict(f) for f in fields]

    def secrets(self):
        return {f["key"] for f in self.fields if f.get("secret")}

    def describe(self):
        return {"kind": self.kind, "label": self.label, "label_zh": self.label_zh,
                "fields": [{k: f.get(k) for k in
                            ("key", "label", "label_zh", "secret", "required", "default")}
                           for f in self.fields]}


def resolve(value):
    """``env:NAME`` -> environment value; anything else unchanged."""
    if isinstance(value, str) and value.startswith("env:"):
        return os.environ.get(value[4:].strip(), "")
    return value


class ChannelManager:
    """CRUD + lifecycle + logs for channel instances; one per hub."""

    LOG_SIZE = 300

    def __init__(self, hub, store):
        self.hub, self.store = hub, store
        self.lock = threading.RLock()
        self.providers = {}
        self.channels = {c["id"]: c for c in store.load()}
        self.runtime = {}  # id -> {"state", "error", "since", "dispose"}
        self.logs = {}
        self.closed = False

    # -- logging -------------------------------------------------------
    def log(self, cid, level, text):
        with self.lock:
            buf = self.logs.setdefault(cid, deque(maxlen=self.LOG_SIZE))
            buf.append({"t": time.time(), "level": level, "text": str(text)[:2000]})

    def logger(self, cid):
        return lambda level, text: self.log(cid, level, text)

    # -- providers -----------------------------------------------------
    def register_provider(self, provider):
        """Make a provider available; auto-starts its enabled channels.
        Returns a disposer that stops those channels and removes it."""
        with self.lock:
            if provider.kind in self.providers:
                raise ValueError(f"provider already registered: {provider.kind}")
            self.providers[provider.kind] = provider
            ids = [c["id"] for c in self.channels.values()
                   if c.get("provider") == provider.kind and c.get("enabled")]
        for cid in ids:
            try:
                self.start(cid)
            except Exception:
                pass  # recorded in runtime/logs by start()

        def dispose():
            with self.lock:
                if self.providers.get(provider.kind) is not provider:
                    return
                ids = [c["id"] for c in self.channels.values()
                       if c.get("provider") == provider.kind]
            for cid in ids:
                self._halt(cid, "provider unloaded")
            with self.lock:
                self.providers.pop(provider.kind, None)
        return dispose

    # -- views ---------------------------------------------------------
    def _view(self, c):
        provider = self.providers.get(c.get("provider"))
        secret = provider.secrets() if provider else set()
        cfg = c.get("config") or {}
        rt = self.runtime.get(c["id"]) or {}
        return {"id": c["id"], "name": c.get("name") or c["id"],
                "provider": c.get("provider"), "enabled": bool(c.get("enabled")),
                "available": provider is not None,
                "config": {k: v for k, v in cfg.items() if k not in secret},
                "secrets_set": sorted(k for k in secret if cfg.get(k)),
                "state": rt.get("state", "stopped"), "error": rt.get("error"),
                "since": rt.get("since")}

    def snapshot(self):
        with self.lock:
            return {"providers": [p.describe() for p in self.providers.values()],
                    "channels": [self._view(c) for c in self.channels.values()]}

    def get_logs(self, cid, after=0):
        with self.lock:
            if cid not in self.channels:
                raise KeyError(cid)
            return [e for e in self.logs.get(cid, ()) if e["t"] > after]

    # -- CRUD ----------------------------------------------------------
    def _persist(self):
        self.store.save(list(self.channels.values()))

    def _merge_config(self, provider, old, new):
        cfg = dict(old or {})
        known = {f["key"] for f in provider.fields} if provider else set(new)
        secret = provider.secrets() if provider else set()
        for k, v in (new or {}).items():
            if k not in known:
                continue
            v = "" if v is None else str(v).strip()
            if k in secret and not v:
                continue  # empty = keep stored secret
            cfg[k] = v
        return cfg

    def create(self, body):
        kind = (body or {}).get("provider")
        cid = ((body or {}).get("id") or "").strip().lower() or \
            f"{kind}-{uuid.uuid4().hex[:6]}"
        with self.lock:
            provider = self.providers.get(kind)
            if provider is None:
                raise ValueError(f"unknown provider: {kind}")
            if not ID_RE.match(cid) or cid in self.channels or cid in self.hub.adapters:
                raise ValueError(f"invalid or duplicate channel id: {cid}")
            c = {"id": cid, "provider": kind,
                 "name": (body.get("name") or "").strip() or cid, "enabled": False,
                 "config": self._merge_config(provider, {}, body.get("config"))}
            self.channels[cid] = c
            self._persist()
        self.log(cid, "info", "channel created")
        return self._view(c)

    def update(self, cid, body):
        with self.lock:
            c = self.channels.get(cid)
            if c is None:
                raise KeyError(cid)
            provider = self.providers.get(c.get("provider"))
            if "name" in body:
                c["name"] = (body.get("name") or "").strip() or cid
            if "config" in body:
                c["config"] = self._merge_config(provider, c.get("config"), body["config"])
            for k in (body.get("clear_secrets") or []):
                (c.get("config") or {}).pop(k, None)
            self._persist()
            running = (self.runtime.get(cid) or {}).get("state") == "running"
        self.log(cid, "info", "configuration updated")
        if running and "config" in body:
            self.restart(cid)
        return self._view(self.channels[cid])

    def delete(self, cid):
        self._halt(cid, "channel deleted")
        with self.lock:
            if self.channels.pop(cid, None) is None:
                raise KeyError(cid)
            self.runtime.pop(cid, None)
            self.logs.pop(cid, None)
            self._persist()

    # -- lifecycle -----------------------------------------------------
    def _set(self, cid, state, error=None, dispose=None):
        self.runtime[cid] = {"state": state, "error": error,
                             "since": time.time(), "dispose": dispose}

    def start(self, cid, *, persist=True):
        with self.lock:
            c = self.channels.get(cid)
            if c is None:
                raise KeyError(cid)
            if (self.runtime.get(cid) or {}).get("state") == "running":
                return self._view(c)
            provider = self.providers.get(c.get("provider"))
            if provider is None:
                raise ValueError(f"provider not available: {c.get('provider')}")
            if persist and not c.get("enabled"):
                c["enabled"] = True
                self._persist()
            cfg = {k: resolve(v) for k, v in (c.get("config") or {}).items()}
            missing = [f["key"] for f in provider.fields
                       if f.get("required") and not cfg.get(f["key"])]
            self._set(cid, "starting")
        self.log(cid, "info", "starting")
        try:
            if missing:
                raise ValueError("missing required: " + ", ".join(missing))
            adapter = provider.factory(cid, cfg, self.logger(cid))
            dispose = self.hub.register(adapter)
        except Exception as e:
            with self.lock:
                self._set(cid, "error", f"{type(e).__name__}: {e}")
            self.log(cid, "error", f"start failed: {e}")
            raise
        with self.lock:
            self._set(cid, "running", dispose=dispose)
        self.log(cid, "info", "running")
        return self._view(self.channels[cid])

    def _halt(self, cid, reason):
        with self.lock:
            rt = self.runtime.get(cid) or {}
            dispose = rt.get("dispose")
            if rt:
                self._set(cid, "stopped")
        if dispose:
            try:
                dispose()
            except Exception as e:
                self.log(cid, "error", f"stop error: {e}")
            self.log(cid, "info", f"stopped ({reason})")

    def stop(self, cid):
        with self.lock:
            c = self.channels.get(cid)
            if c is None:
                raise KeyError(cid)
            if c.get("enabled"):
                c["enabled"] = False
                self._persist()
        self._halt(cid, "by user")
        return self._view(c)

    def restart(self, cid):
        self._halt(cid, "restart")
        return self.start(cid)

    def fail(self, cid, error):
        """Adapters call this (via provider) when the connection dies."""
        with self.lock:
            rt = self.runtime.get(cid)
            if rt and rt.get("state") == "running":
                rt.update(state="error", error=str(error), since=time.time())
        self.log(cid, "error", error)

    def close(self):
        self.closed = True
        for cid in list(self.runtime):
            self._halt(cid, "shutdown")
