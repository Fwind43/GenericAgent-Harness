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


def _supported(key, value):
    return (isinstance(value, dict) and llmconfig.is_llm_key(key)
            and ("oai" in key or "claude" in key) and "mixin" not in key)


def _safe_url(value):
    try:
        u = urlsplit(value)
        return u.scheme in ("http", "https") and bool(u.hostname) and not (u.username or u.password or u.query or u.fragment)
    except ValueError:
        return False


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
    def __init__(self, agent, source=None):
        self.agent = agent
        self.source = source
        self.lock = threading.RLock()

    def _idle(self):
        q = getattr(self.agent, "task_queue", None)
        if getattr(self.agent, "is_running", False) or getattr(q, "unfinished_tasks", 0):
            raise RuntimeError("wait for the running task to finish")

    def catalog(self):
        rows = []
        current = None
        for i, c in enumerate(self.agent.llmclients):
            b = getattr(c, "backend", None)
            if b is None:
                continue
            rows.append({"id": i, "name": getattr(b, "name", "") or getattr(b, "model", ""),
                         "model": getattr(b, "model", "")})
            if c is self.agent.llmclient:
                current = i
        return {"items": rows, "current": current}

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

    def config(self):
        with self.lock:
            try:
                _, _, data, revision = self._read()
            except ValueError as e:
                return {"writable": False, "reason": str(e), "entries": []}
            entries = []
            for key, value in data.items():
                if not _supported(key, value):
                    continue
                public = {k: value[k] for k in _FIELDS if k in value}
                # Only plain environment references may pass through; defaults can
                # contain literal credentials. Never expand secrets for the browser.
                url = value.get("apibase", "")
                env_ref = r"\$\{[A-Za-z_][A-Za-z0-9_]*\}"
                template = re.sub(env_ref, "env-reference", url) if isinstance(url, str) else ""
                reference_only = isinstance(url, str) and re.fullmatch(env_ref, url) is not None
                hidden_url = not (reference_only or ("${" not in template and _safe_url(template)))
                if hidden_url:
                    public.pop("apibase", None)
                entries.append({"key": key, "values": public, "has_key": bool(value.get("apikey")),
                                "url_hidden": hidden_url})
            return {"writable": True, "revision": revision, "entries": entries}

    def change(self, body):
        with self.lock:
            self._idle()
            path, original, data, revision = self._read()
            if body.get("revision") != revision:
                raise RuntimeError("model file changed; reload settings before saving")
            key = body.get("key")
            if not isinstance(key, str) or not _KEY.fullmatch(key):
                raise ValueError("invalid configuration identifier")
            action = body.get("action")
            if action == "delete":
                if key not in data or not _supported(key, data[key]):
                    raise ValueError("unknown model configuration")
                if any("mixin" in k for k in data):
                    raise ValueError("remove mixin dependencies locally before deleting a model")
                del data[key]
            elif action == "save":
                if key in data and not _supported(key, data[key]):
                    raise ValueError("this configuration is not editable")
                cfg = copy.deepcopy(data.get(key, {}))
                values = body.get("values")
                if not isinstance(values, dict) or set(values) - set(_FIELDS) - {"apikey"}:
                    raise ValueError("invalid model fields")
                for k, v in values.items():
                    if k == "apikey" and not v:
                        continue  # empty password means keep existing secret / ENV reference
                    cfg[k] = v.strip() if isinstance(v, str) else v
                if not _supported(key, cfg):
                    raise ValueError("identifier must include oai or claude and config/api/cookie")
                if any(not isinstance(cfg.get(k), str) or not cfg[k].strip() for k in ("model", "apibase", "apikey")):
                    raise ValueError("model, base URL and API key are required")
                if "name" in cfg and (not isinstance(cfg["name"], str) or len(cfg["name"]) > 120):
                    raise ValueError("name must contain at most 120 characters")
                if "context_win" in cfg and (type(cfg["context_win"]) is not int or cfg["context_win"] < 1024):
                    raise ValueError("context window must be an integer of at least 1024")
                try:
                    expanded = llmconfig._expand(cfg)
                except Exception:
                    raise ValueError("a referenced environment variable is not configured") from None
                if not _safe_url(expanded["apibase"]):
                    raise ValueError("base URL must be HTTP(S), without credentials, query or fragment")
                data[key] = cfg
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
                agent.load_llm_sessions()
                if not agent.llmclients or any(not hasattr(c, "backend") for c in agent.llmclients):
                    raise RuntimeError()
                if action == "save":
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
