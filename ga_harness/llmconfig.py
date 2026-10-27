"""LLM configuration without GA's mykey.py.

GA reads LLM configs by ``import mykey`` (llmcore._load_mykeys pops the module
first, then imports again) and hot-reloads when ``mykey.__file__``'s mtime
changes.  We install a meta-path finder that answers ``import mykey`` with a
synthetic module built from a harness config file (TOML/JSON) and/or inline
values, so GA itself stays unmodified.

String values may reference environment variables: ``"${NAME}"`` or
``"${NAME:-default}"`` -- keep secrets out of the file if you like.
"""
from __future__ import annotations
import importlib.abc
import importlib.util
import json
import os
import re
import runpy
import sys
import tomllib
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

MODULE = "mykey"
MYKEY_MODEL_PROVIDERS = "_gah_model_providers"
DEFAULT_FILE = "~/.ga-harness/llm.toml"
_ENV = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}")
_SECRET = re.compile(r"key|token|secret|cookie|passw|auth", re.I)


class ConfigError(Exception):
    pass


def default_path() -> Path:
    return Path(os.path.expanduser(os.environ.get("GAH_LLM_CONFIG") or DEFAULT_FILE))


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


def read_file(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    try:
        data = json.loads(text) if path.suffix.lower() == ".json" else tomllib.loads(text)
    except (ValueError, tomllib.TOMLDecodeError) as e:
        raise ConfigError(f"{path}: {e}") from e
    if not isinstance(data, dict):
        raise ConfigError(f"{path}: top level must be a table/object")
    return data


class Source:
    """Resolved config = file values overlaid by inline values, env-expanded."""

    def __init__(self, file: str | os.PathLike | None = None, inline: dict | None = None):
        self.file = Path(os.path.expanduser(str(file))) if file else None
        self.inline = dict(inline or {})

    @classmethod
    def from_config(cls, config: dict) -> "Source":
        file = config.get("file")
        if file is None and not config.get("keys"):
            file = default_path()
        return cls(file, config.get("keys"))

    @property
    def available(self) -> bool:
        return bool(self.inline) or bool(self.file and self.file.is_file())

    @property
    def origin(self) -> str:
        # GA stats this path for hot reload, so it must exist.
        return str(self.file if self.file and self.file.is_file() else Path(__file__).resolve())

    def load(self) -> dict:
        data = read_file(self.file) if self.file and self.file.is_file() else {}
        data.update(self.inline)
        return {k: v for k, v in _expand(resolve_providers(data)).items() if not k.startswith("_")}


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


class _Loader(importlib.abc.Loader):
    def __init__(self, source: Source):
        self.source = source

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        module.__dict__.update(self.source.load())
        module.__file__ = self.source.origin


class MykeyFinder(importlib.abc.MetaPathFinder):
    def __init__(self, source: Source):
        self.source = source

    def find_spec(self, name, path=None, target=None):
        if name != MODULE:
            return None
        return importlib.util.spec_from_loader(MODULE, _Loader(self.source), origin=self.source.origin)


def install(source: Source) -> MykeyFinder:
    source.load()   # fail fast (bad file / missing env) at plugin activation, not inside GA
    finder = MykeyFinder(source)
    sys.meta_path.insert(0, finder)
    sys.modules.pop(MODULE, None)
    return finder


def uninstall(finder: MykeyFinder) -> None:
    if finder in sys.meta_path:
        sys.meta_path.remove(finder)
    mod = sys.modules.get(MODULE)
    if mod is not None and isinstance(getattr(mod, "__loader__", None), _Loader):
        sys.modules.pop(MODULE, None)


class Fallback:
    """GA's own mykey.py is active (no harness file).  Knows where a harness file
    would live and how to switch GA over to it without a restart."""

    def __init__(self, target: str | os.PathLike, on_adopt=None):
        self.target = Path(os.path.expanduser(str(target)))
        self.on_adopt = on_adopt

    def mykey_path(self) -> Path | None:
        core = sys.modules.get("llmcore")
        p = getattr(core, "_mykey_path", None)
        if not p:
            p = getattr(sys.modules.get(MODULE), "__file__", None)
        return Path(p) if p else None

    @staticmethod
    def _refresh() -> None:
        core = sys.modules.get("llmcore")
        if core is not None and hasattr(core, "_mykey_mtime"):
            core._mykey_mtime = None   # force GA's next reload_mykeys() to re-import

    def adopt(self) -> tuple[Source, MykeyFinder]:
        src = Source(self.target)
        finder = install(src)
        self._refresh()
        return src, finder

    def undo(self, finder: MykeyFinder) -> None:
        uninstall(finder)
        self._refresh()

    def commit(self, finder: MykeyFinder) -> None:
        if self.on_adopt:
            self.on_adopt(finder)


def is_llm_key(name: str) -> bool:
    """Same filter GA's load_llm_sessions uses."""
    return any(x in name for x in ("api", "config", "cookie"))


def mask(v: Any, field: str = "") -> Any:
    if isinstance(v, dict):
        return {k: mask(x, k) for k, x in v.items()}
    if isinstance(v, list):
        return [mask(x, field) for x in v]
    if isinstance(v, str) and _SECRET.search(field) and v:
        return v[:3] + "***" if len(v) > 8 else "***"
    return v


# ---------------------------------------------------------------- migration
_BARE = re.compile(r"^[A-Za-z0-9_-]+$")


def _key(k: str) -> str:
    return k if _BARE.match(k) else json.dumps(k, ensure_ascii=False)


def _val(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(_val(x) for x in v if x is not None) + "]"
    if isinstance(v, dict):
        return "{ " + ", ".join(f"{_key(k)} = {_val(x)}" for k, x in v.items() if x is not None) + " }"
    raise ConfigError(f"cannot write {type(v).__name__} to TOML")


def to_toml(data: dict) -> str:
    plain = {k: v for k, v in data.items() if not isinstance(v, dict) and v is not None}
    tables = {k: v for k, v in data.items() if isinstance(v, dict)}
    out = [f"{_key(k)} = {_val(v)}" for k, v in plain.items()]
    providers = tables.pop(PROVIDERS, None)
    if isinstance(providers, dict) and all(isinstance(v, dict) for v in providers.values()):
        for pid, tbl in providers.items():
            out += ["", f"[{PROVIDERS}.{_key(pid)}]"] + [f"{_key(k)} = {_val(v)}" for k, v in tbl.items() if v is not None]
    elif providers is not None:
        tables = {PROVIDERS: providers} | tables
    for name, tbl in tables.items():
        out += ["", f"[{_key(name)}]"] + [f"{_key(k)} = {_val(v)}" for k, v in tbl.items() if v is not None]
    return "\n".join(out) + "\n"


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
        try:
            _val(v)
            data[k] = v
        except ConfigError:
            skipped.append(k)
    return data | ({"_skipped": skipped} if skipped else {})
