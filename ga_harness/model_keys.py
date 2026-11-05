"""Stable model identity: the mykey.py variable name behind each live GA client.

GA only exposes ``backend.name`` (the display name, or the model id when no
name is set), which is not unique. The harness tags every client GA builds with
the configuration key it came from, so per-conversation selection, worker runs
and the conductor can pin a model by key and fall back to the name only for
state saved before keys existed.

GA source is left untouched: ``install`` wraps ``resolve_client`` in the agent
module's namespace (non-mixin entries) and ``GenericAgent.load_llm_sessions``
(failover groups, which GA builds in mykey.py order).
"""
from __future__ import annotations

import logging
import sys

ATTR = "_gah_key"
_FLAG = "_gah_model_keys_installed"


def key_of(client) -> str | None:
    key = getattr(client, ATTR, None)
    return key if isinstance(key, str) and key else None


def name_of(client) -> str:
    backend = getattr(client, "backend", None)
    return getattr(backend, "name", "") or ""


def find(clients, key=None, name=None):
    """(index, client) for a saved selection, or None.

    The key wins. A name is only used when no key was saved, or the saved key
    no longer exists (e.g. renamed in mykey.py) and the name is unambiguous.
    """
    live = [(i, c) for i, c in enumerate(clients or []) if hasattr(c, "backend")]
    if isinstance(key, str) and key:
        for i, c in live:
            if key_of(c) == key:
                return i, c
        if isinstance(name, str) and name:
            hits = [(i, c) for i, c in live if name_of(c) == name]
            return hits[0] if len(hits) == 1 else None
        return None
    if isinstance(name, str) and name:
        for i, c in live:
            if name_of(c) == name:
                return i, c
    return None


def selection(agent) -> dict:
    """{"model": display name, "model_key": config key} of the agent's current client."""
    client = getattr(agent, "llmclient", None)
    return {"model": name_of(client), "model_key": key_of(client)}


def _llm_key(name: str) -> bool:
    return any(x in name for x in ("api", "config", "cookie"))   # GA's own filter


def _tag_mixins(agent) -> None:
    clients = getattr(agent, "llmclients", None) or []
    untagged = [c for c in clients if key_of(c) is None]
    if not untagged:
        return
    mykeys = getattr(sys.modules.get("llmcore"), "mykeys", None)
    if not isinstance(mykeys, dict):
        return
    mixins = [k for k in mykeys if isinstance(k, str) and _llm_key(k) and "mixin" in k]
    # GA always keeps one slot per mixin key (a dict when the group failed), in order;
    # anything else untagged means our view of the file is off, so tag nothing.
    if len(mixins) != len(untagged):
        return
    for key, client in zip(mixins, untagged):
        if not isinstance(client, dict):
            try:
                setattr(client, ATTR, key)
            except Exception:
                pass


def install(mod) -> None:
    """Patch the agent module once, before any GenericAgent is created."""
    if mod is None or getattr(mod, _FLAG, False):
        return
    resolve = getattr(mod, "resolve_client", None)
    if callable(resolve):
        def resolve_client(cfg_name, *args, **kwargs):
            client = resolve(cfg_name, *args, **kwargs)
            if client is not None:
                try:
                    setattr(client, ATTR, cfg_name)
                except Exception:
                    pass
            return client
        mod.resolve_client = resolve_client
    cls = getattr(mod, "GenericAgent", None)
    load = getattr(cls, "load_llm_sessions", None)
    if callable(load):
        def load_llm_sessions(self, *args, **kwargs):
            result = load(self, *args, **kwargs)
            try:
                _tag_mixins(self)
            except Exception:
                logging.getLogger(__name__).exception("tagging failover groups failed")
            return result
        cls.load_llm_sessions = load_llm_sessions
    try:
        setattr(mod, _FLAG, True)
    except Exception:
        pass
