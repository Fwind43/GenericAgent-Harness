"""Local model management, independent of any frontend. Never return API keys."""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading
from urllib.parse import urlsplit

from ga_harness import llmconfig

_FIELDS = ("name", "model", "apibase", "context_win")
_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,99}$")
_PID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
_PFIELDS = ("name", "protocol", "apibase")
_PROTOCOLS = ("oai", "claude")
_ENV_REF = r"\$\{[A-Za-z_][A-Za-z0-9_]*\}"


def _supported(key, value):
    return (isinstance(value, dict) and llmconfig.is_llm_key(key)
            and ("oai" in key or "claude" in key) and "mixin" not in key)


def _safe_url(value):
    try:
        u = urlsplit(value)
        return u.scheme in ("http", "https") and bool(u.hostname) and not (u.username or u.password or u.query or u.fragment)
    except ValueError:
        return False


def _protocol(key):
    return "claude" if "claude" in key else "oai"


def _public_url(url):
    """Return (url_or_None, hidden). Only plain ${ENV} references may pass through;
    defaults can contain literal credentials. Never expand secrets for the browser."""
    template = re.sub(_ENV_REF, "env-reference", url) if isinstance(url, str) else ""
    reference_only = isinstance(url, str) and re.fullmatch(_ENV_REF, url) is not None
    hidden = not (reference_only or ("${" not in template and _safe_url(template)))
    return (None if hidden else url), hidden


def _check_url(value):
    try:
        expanded = llmconfig._expand(value)
    except Exception:
        raise ValueError("a referenced environment variable is not configured") from None
    if not _safe_url(expanded):
        raise ValueError("base URL must be HTTP(S), without credentials, query or fragment")


def _replace(path, payload):
    """Replace only the configured file, with no persistent secret-bearing backup."""
    path.parent.mkdir(parents=True, exist_ok=True)
    old_ns = path.stat().st_mtime_ns if path.exists() else 0
    fd, name = tempfile.mkstemp(prefix=".gah-models-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        if path.exists():
            os.chmod(name, path.stat().st_mode & 0o777)
        ns = max(Path(name).stat().st_mtime_ns, old_ns + 1)
        os.utime(name, ns=(ns, ns))
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class Models:
    def __init__(self, agent, source=None, fallback=None):
        self.agent = agent
        self.source = source
        self.fallback = fallback if source is None else None
        self.lock = threading.RLock()

    def _idle(self):
        q = getattr(self.agent, "task_queue", None)
        if getattr(self.agent, "is_running", False) or getattr(q, "unfinished_tasks", 0):
            raise RuntimeError("wait for the running task to finish")

    def select(self, index):
        with self.lock:
            self._idle()
            if type(index) is not int or index not in [x["id"] for x in self.catalog()["items"]]:
                raise ValueError("unknown model")
            self.agent.next_llm(index)
            return self.catalog()

    def _file(self):
        if self.source is None or self.source.file is None or self.source.inline:
            raise ValueError("web editing requires a harness TOML/JSON file without inline overrides; GA mykey.py is read-only")
        return self.source.file

    def _read(self):
        path = self._file()
        payload = path.read_bytes() if path.exists() else b""
        try:
            data = (json.loads(payload) if path.suffix.lower() == ".json"
                    else llmconfig.tomllib.loads(payload.decode("utf-8"))) if payload else {}
            if not isinstance(data, dict):
                raise ValueError()
        except Exception:
            raise ValueError("model file is invalid; fix it locally before editing") from None
        return path, payload, data, hashlib.sha256(payload).hexdigest()

    def _providers(self, data):
        p = data.get(llmconfig.PROVIDERS, {})
        if not isinstance(p, dict) or any(not isinstance(v, dict) for v in p.values()):
            raise ValueError("providers table is invalid; fix it locally before editing")
        return p

    def _group_of(self):
        """(name, model) -> provider display name, for the composer picker."""
        try:
            _, _, data, _ = self._read()
            providers = self._providers(data)
        except Exception:
            return {}
        out = {}
        for k, v in data.items():
            if _supported(k, v) and v.get("provider") in providers:
                pv = providers[v["provider"]]
                out[(v.get("name") or v.get("model"), v.get("model"))] = pv.get("name") or v["provider"]
        return out

    def catalog(self):
        rows = []
        current = None
        groups = self._group_of() if self.source is not None else {}
        for i, c in enumerate(self.agent.llmclients):
            b = getattr(c, "backend", None)
            if b is None:
                continue
            name = getattr(b, "name", "") or getattr(b, "model", "")
            model = getattr(b, "model", "")
            rows.append({"id": i, "name": name, "model": model, "provider": groups.get((name, model))})
            if c is self.agent.llmclient:
                current = i
        return {"items": rows, "current": current}

    def config(self):
        with self.lock:
            try:
                _, _, data, revision = self._read()
                providers = self._providers(data)
            except ValueError as e:
                out = {"writable": False, "reason": str(e), "entries": [], "providers": []}
                if self.source is None:
                    out["reason_code"] = "ga_mykey"
                    if self.fallback is not None:
                        out["convert"] = {"target": str(self.fallback.target),
                                          "blocked": self.fallback.target.exists()}
                elif self.source.inline:
                    out["reason_code"] = "inline"
                else:
                    out["reason_code"] = "invalid"
                return out
            entries = []
            count = {}
            for key, value in data.items():
                if not _supported(key, value):
                    continue
                pid = value.get("provider") if value.get("provider") in providers else None
                public = {k: value[k] for k in _FIELDS if k in value}
                hidden = False
                if pid is None:
                    url, hidden = _public_url(value.get("apibase", ""))
                    public.pop("apibase", None)
                    if url is not None and "apibase" in value:
                        public["apibase"] = url
                else:
                    public.pop("apibase", None)
                    count[pid] = count.get(pid, 0) + 1
                entries.append({"key": key, "values": public, "provider": pid, "protocol": _protocol(key),
                                "has_key": bool(value.get("apikey")), "url_hidden": hidden})
            plist = []
            for pid, pv in providers.items():
                url, hidden = _public_url(pv.get("apibase", ""))
                values = {"name": pv.get("name", ""), "protocol": pv.get("protocol", "oai")}
                if url is not None:
                    values["apibase"] = url
                plist.append({"id": pid, "values": values, "has_key": bool(pv.get("apikey")),
                              "url_hidden": hidden, "models": count.get(pid, 0)})
            return {"writable": True, "revision": revision, "entries": entries, "providers": plist}

    def _provider_change(self, data, action, body):
        providers = self._providers(data)
        pid = body.get("id")
        if not isinstance(pid, str) or not _PID.fullmatch(pid):
            raise ValueError("provider id must be 1-40 lowercase letters, digits, - or _")
        used = [k for k, v in data.items() if _supported(k, v) and v.get("provider") == pid]
        if action == "provider_delete":
            if pid not in providers:
                raise ValueError("unknown provider")
            if used:
                raise ValueError("remove or move this provider's models before deleting it")
            del providers[pid]
        else:
            values = body.get("values")
            if not isinstance(values, dict) or set(values) - set(_PFIELDS) - {"apikey"}:
                raise ValueError("invalid provider fields")
            cfg = copy.deepcopy(providers.get(pid, {}))
            for k, v in values.items():
                if k == "apikey" and not v:
                    continue
                cfg[k] = v.strip() if isinstance(v, str) else v
            cfg.setdefault("protocol", "oai")
            if cfg["protocol"] not in _PROTOCOLS:
                raise ValueError("protocol must be oai or claude")
            if used and any(_protocol(k) != cfg["protocol"] for k in used):
                raise ValueError("protocol cannot change while the provider has models")
            if not isinstance(cfg.get("name", ""), str) or len(cfg.get("name", "")) > 120:
                raise ValueError("name must contain at most 120 characters")
            if any(not isinstance(cfg.get(k), str) or not cfg[k].strip() for k in ("apibase", "apikey")):
                raise ValueError("base URL and API key are required")
            _check_url(cfg["apibase"])
            providers[pid] = cfg
        if providers:
            data[llmconfig.PROVIDERS] = providers
        else:
            data.pop(llmconfig.PROVIDERS, None)
        return bool(used)

    def convert(self):
        """Copy GA's mykey.py into the harness file and switch to it; mykey.py is left untouched."""
        with self.lock:
            self._idle()
            fb = self.fallback
            if self.source is not None or fb is None:
                raise ValueError("model configuration is already editable")
            target = fb.target
            if target.exists():
                raise ValueError(f"{target} already exists; restart gah to use it")
            mykey = fb.mykey_path()
            if mykey is None or not mykey.is_file():
                raise ValueError("GA mykey.py was not found")
            try:
                data = llmconfig.read_mykey_py(mykey)
                data.pop("_skipped", None)
                payload = llmconfig.to_toml(data).encode("utf-8")
                llmconfig.tomllib.loads(payload.decode("utf-8"))
            except Exception:
                raise ValueError("GA mykey.py could not be converted; run 'gah llm migrate' locally") from None
            agent = self.agent
            old = agent.llmclients, agent.llmclient, getattr(agent, "llm_no", 0)
            finder = None
            _replace(target, payload)
            try:
                src, finder = fb.adopt()
                agent.load_llm_sessions()
                if not agent.llmclients or any(not hasattr(c, "backend") for c in agent.llmclients):
                    raise RuntimeError()
            except Exception:
                if finder is not None:
                    fb.undo(finder)
                target.unlink(missing_ok=True)
                try:
                    agent.load_llm_sessions()
                finally:
                    agent.llmclients, agent.llmclient, agent.llm_no = old
                raise RuntimeError("conversion failed; GA mykey.py is still in use") from None
            fb.commit(finder)
            self.source, self.fallback = src, None
            return self.config()

    def change(self, body):
        with self.lock:
            self._idle()
            if body.get("action") == "convert":
                return self.convert()
            path, original, data, revision = self._read()
            if body.get("revision") != revision:
                raise RuntimeError("model file changed; reload settings before saving")
            action = body.get("action")
            expanded = None
            if action in ("provider_save", "provider_delete"):
                affects_models = self._provider_change(data, action, body)
            else:
                affects_models = True
                key = body.get("key")
                if not isinstance(key, str) or not _KEY.fullmatch(key):
                    raise ValueError("invalid configuration identifier")
                if action == "delete":
                    if key not in data or not _supported(key, data[key]):
                        raise ValueError("unknown model configuration")
                    if any("mixin" in k for k in data):
                        raise ValueError("remove mixin dependencies locally before deleting a model")
                    del data[key]
                elif action == "save":
                    expanded = self._model_save(data, key, body)
                else:
                    raise ValueError("unknown model action")
                if not any(_supported(k, v) for k, v in data.items()):
                    raise ValueError("keep at least one model configuration")
            try:
                payload = (json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
                           if path.suffix.lower() == ".json" else llmconfig.to_toml(data)).encode("utf-8")
            except Exception:
                raise ValueError("model configuration cannot be serialized") from None
            agent = self.agent
            old = agent.llmclients, agent.llmclient, getattr(agent, "llm_no", 0)
            try:
                _replace(path, payload)
                if affects_models:
                    agent.load_llm_sessions()
                    if not agent.llmclients or any(not hasattr(c, "backend") for c in agent.llmclients):
                        raise RuntimeError()
                    if expanded is not None:
                        wanted = expanded.get("name") or expanded["model"]
                        if not any(c.backend.name == wanted and c.backend.model == expanded["model"] for c in agent.llmclients):
                            raise RuntimeError()
            except Exception:
                _replace(path, original)
                try:
                    agent.load_llm_sessions()  # also restore GA's configuration cache
                finally:
                    agent.llmclients, agent.llmclient, agent.llm_no = old
                raise RuntimeError("model reload failed; previous file and active model were restored") from None
            return self.config()

    def _model_save(self, data, key, body):
        if key in data and not _supported(key, data[key]):
            raise ValueError("this configuration is not editable")
        providers = self._providers(data)
        cfg = copy.deepcopy(data.get(key, {}))
        values = body.get("values")
        if not isinstance(values, dict) or set(values) - set(_FIELDS) - {"apikey", "provider"}:
            raise ValueError("invalid model fields")
        pid = values.get("provider", cfg.get("provider"))
        for k, v in values.items():
            if k == "apikey" and not v:
                continue  # empty password means keep existing secret / ENV reference
            if k == "provider":
                continue
            cfg[k] = v.strip() if isinstance(v, str) else v
        if not _supported(key, cfg):
            raise ValueError("identifier must include oai or claude and config/api/cookie")
        if pid:
            if pid not in providers:
                raise ValueError("unknown provider")
            if _protocol(key) != providers[pid].get("protocol", "oai"):
                raise ValueError("model identifier protocol does not match the provider")
            # connection now comes from the provider
            cfg.pop("apibase", None)
            cfg.pop("apikey", None)
            cfg["provider"] = pid
        else:
            cfg.pop("provider", None)
        if "name" in cfg and (not isinstance(cfg["name"], str) or len(cfg["name"]) > 120):
            raise ValueError("name must contain at most 120 characters")
        if "context_win" in cfg and (type(cfg["context_win"]) is not int or cfg["context_win"] < 1024):
            raise ValueError("context window must be an integer of at least 1024")
        try:
            merged = llmconfig.resolve_providers({llmconfig.PROVIDERS: providers, key: cfg})[key]
        except llmconfig.ConfigError as e:
            raise ValueError(str(e)) from None
        if any(not isinstance(merged.get(k), str) or not merged[k].strip() for k in ("model", "apibase", "apikey")):
            raise ValueError("model, base URL and API key are required")
        try:
            expanded = llmconfig._expand(merged)
        except Exception:
            raise ValueError("a referenced environment variable is not configured") from None
        if not _safe_url(expanded["apibase"]):
            raise ValueError("base URL must be HTTP(S), without credentials, query or fragment")
        data[key] = cfg
        return expanded
