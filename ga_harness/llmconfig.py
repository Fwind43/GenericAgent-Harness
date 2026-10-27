"""Helpers for GA's native ``mykey.py`` model configuration.

GA reads LLM configs by ``import mykey`` and hot-reloads when ``mykey.__file__``'s
mtime changes.  The harness reads and edits that file in place; there is no
separate harness configuration format.

String values may reference environment variables: ``"${NAME}"`` or
``"${NAME:-default}"``.
"""
from __future__ import annotations
import os
import re
import runpy
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

MODULE = "mykey"
MYKEY_MODEL_PROVIDERS = "_gah_model_providers"
_ENV = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}")


class ConfigError(Exception):
    pass


def _expand(v: Any, where: str = "") -> Any:
    if isinstance(v, str):
        def sub(m):
            val = os.environ.get(m.group(1), m.group(2))
            if val is None:
                raise ConfigError(f"{where or 'value'}: environment variable {m.group(1)} is not set")
            return val
        return _ENV.sub(sub, v)
    if isinstance(v, dict):
        return {k: _expand(x, f"{where}.{k}" if where else k) for k, x in v.items()}
    if isinstance(v, list):
        return [_expand(x, f"{where}[{i}]") for i, x in enumerate(v)]
    return v


PROVIDERS = "providers"
_PROVIDER_META = ("name", "protocol")


def resolve_providers(data: dict) -> dict:
    """Flatten ``[providers.<id>]`` into GA's per-model mykey shape.

    A model table with ``provider = "<id>"`` inherits that provider's fields
    (``apibase``, ``apikey`` and any other connection options) unless it sets
    them itself.  The ``providers`` table never reaches GA, so providers with
    no models stay invisible to it.
    """
    providers = data.get(PROVIDERS, {})
    if not isinstance(providers, dict) or any(not isinstance(v, dict) for v in providers.values()):
        raise ConfigError(f"{PROVIDERS} must be a table of tables")
    out = {}
    for k, v in data.items():
        if k in (PROVIDERS, MYKEY_MODEL_PROVIDERS):
            continue
        if isinstance(v, dict) and "provider" in v:
            pid = v["provider"]
            if not isinstance(pid, str) or pid not in providers:
                raise ConfigError(f"{k}: unknown provider {pid!r}")
            base = {x: y for x, y in providers[pid].items() if x not in _PROVIDER_META}
            v = base | {x: y for x, y in v.items() if x != "provider"}
        out[k] = v
    return out


def mykey_path() -> Path | None:
    """Path of the mykey.py GA actually loaded."""
    core = sys.modules.get("llmcore")
    p = getattr(core, "_mykey_path", None)
    if not p:
        p = getattr(sys.modules.get(MODULE), "__file__", None)
    return Path(p) if p else None


def refresh_mykey() -> None:
    core = sys.modules.get("llmcore")
    if core is not None and hasattr(core, "_mykey_mtime"):
        core._mykey_mtime = None   # force GA's next reload_mykeys() to re-import


def is_llm_key(name: str) -> bool:
    """Same filter GA's load_llm_sessions uses."""
    return any(x in name for x in ("api", "config", "cookie"))


def _provider_id(apibase: str, taken: set) -> str:
    try:
        host = urlsplit(_expand(apibase)).hostname or ""
    except Exception:
        host = ""
    parts = [x for x in host.lower().split(".") if x and x not in ("www", "api")]
    if len(parts) > 1 and not all(x.isdigit() for x in parts):
        parts = parts[:-1]   # drop the TLD: api.openai.com -> openai
    base = re.sub(r"[^a-z0-9_-]+", "-", "-".join(parts)).strip("-_")[:32] or "provider"
    pid, n = base, 2
    while pid in taken:
        pid, n = f"{base}-{n}", n + 1
    taken.add(pid)
    return pid


def group_providers(data: dict) -> dict:
    """Lift shared connection settings of mykey-style models into ``[providers]``.

    Models are grouped only when ``apibase`` and ``apikey`` are identical;
    protocol stays with each model. No credential is reassigned: a shared
    endpoint alone does not merge.  Returns ``data`` unchanged when it already
    has providers or when the result would not resolve to the same models.
    """
    if PROVIDERS in data:
        return data
    groups, order = {}, []
    for k, v in data.items():
        if not (isinstance(v, dict) and is_llm_key(k) and ("oai" in k or "claude" in k) and "mixin" not in k):
            continue
        base, key = v.get("apibase"), v.get("apikey")
        if not (isinstance(base, str) and base.strip() and isinstance(key, str) and key.strip()):
            continue
        g = (base, key)
        if g not in groups:
            groups[g] = []
            order.append(g)
        groups[g].append(k)
    if not groups:
        return data
    taken, providers, owner = set(), {}, {}
    for g in order:
        base, key = g
        # A default for new models only; each model identifier owns its protocol.
        protocol = "claude" if "claude" in groups[g][0] else "oai"
        pid = _provider_id(base, taken)
        try:
            host = urlsplit(_expand(base)).hostname or pid
        except Exception:
            host = pid
        providers[pid] = {"name": host, "protocol": protocol, "apibase": base, "apikey": key}
        for k in groups[g]:
            owner[k] = pid
    names = {}
    for p in providers.values():   # same host twice (e.g. two keys): tell them apart
        names.setdefault(p["name"], []).append(p)
    for same in names.values():
        if len(same) > 1:
            for i, p in enumerate(same, 1):
                p["name"] = f"{p['name']} ({i})"
    out = {PROVIDERS: providers}
    for k, v in data.items():
        if k in owner:
            v = {"provider": owner[k]} | {x: y for x, y in v.items() if x not in ("apibase", "apikey")}
        out[k] = v
    try:
        if resolve_providers(out) != data:
            return data
    except ConfigError:
        return data
    return out


def _plain(v: Any) -> bool:
    if v is None or isinstance(v, (bool, int, float, str)):
        return True
    if isinstance(v, (list, tuple)):
        return all(_plain(x) for x in v)
    if isinstance(v, dict):
        return all(isinstance(k, str) and _plain(x) for k, x in v.items())
    return False


def read_mykey_py(path: str | os.PathLike) -> dict:
    ns = runpy.run_path(str(path))
    skipped = []
    data = {}
    for k, v in ns.items():
        if k == MYKEY_MODEL_PROVIDERS:
            # Keep malformed ownership visible so an edit cannot silently drop it.
            data[k] = v
            continue
        if k.startswith("_"):
            continue
        if _plain(v):
            data[k] = v
        else:
            skipped.append(k)
    return data | ({"_skipped": skipped} if skipped else {})
