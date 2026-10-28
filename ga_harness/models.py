"""Local model management, independent of any frontend. Never return API keys."""
from __future__ import annotations

import ast
import copy
import hashlib
import os
from pathlib import Path
import pprint
import re
import sys
import tempfile
import json
import threading
import urllib.error
import urllib.request
from urllib.parse import urlencode, urlsplit

from ga_harness import llmconfig

_FIELDS = ("name", "model", "apibase", "context_win")
# Per-model GA llmcore options (BaseSession / NativeClaudeSession). None or "" deletes the key so GA
# falls back to its own default. Mixin-only keys (llm_nos/base_delay/spring_back) are not editable here.
_ADVANCED = {
    "max_tokens": ("int", 1, None), "temperature": ("float", 0, 2), "stream": ("bool",),
    "reasoning_effort": ("enum", ("none", "minimal", "low", "medium", "high", "xhigh", "max")),
    "thinking_type": ("enum", ("adaptive", "enabled", "disabled")),
    "thinking_budget_tokens": ("int", 0, None), "omit_thinking": ("bool",),
    "service_tier": ("enum", ("auto", "default", "priority", "flex")),
    "api_mode": ("enum", ("chat_completions", "responses")),
    "api_key_header": ("enum", ("auto", "x-api-key", "bearer")),
    "user_agent": ("str", 300), "fake_cc_system_prompt": ("bool",),
    "proxy": ("proxy",), "timeout": ("int", 1, None), "read_timeout": ("int", 5, None), "verify": ("verify", 500),
    "max_retries": ("int", 0, 100), "max_retry_after": ("float", 0, None),
    "trim_keep_prefix": ("int", 0, None),
    "extra_sys_prompt": ("text", 50000), "extra_sys_prompt_file": ("str", 500),
}


def _advanced_value(key, value):
    spec = _ADVANCED[key]
    kind = spec[0]
    if kind == "verify":  # requests: bool, or a CA bundle path
        if type(value) is bool:
            return value
        kind = "str"
    if kind == "bool":
        if type(value) is not bool:
            raise ValueError(f"{key} must be true or false")
        return value
    if kind in ("int", "float"):
        if type(value) is bool or not isinstance(value, (int, float)) or (kind == "int" and type(value) is not int):
            raise ValueError(f"{key} must be {'an integer' if kind == 'int' else 'a number'}")
        lo, hi = spec[1], spec[2]
        if value != value or (lo is not None and value < lo) or (hi is not None and value > hi):
            raise ValueError(f"{key} must be between {lo} and {hi}" if hi is not None else f"{key} must be at least {lo}")
        return value
    if not isinstance(value, str):
        raise ValueError(f"{key} must be text")
    if kind == "text":
        if len(value) > spec[1]:
            raise ValueError(f"{key} must contain at most {spec[1]} characters")
        return value
    value = value.strip()
    if kind == "enum":
        value = value.lower()
        if value not in spec[1]:
            raise ValueError(f"{key} must be one of: {', '.join(spec[1])}")
        return value
    if kind == "proxy":
        u = urlsplit(value)
        if u.scheme not in ("http", "https", "socks5", "socks5h") or not u.hostname or len(value) > 500:
            raise ValueError("proxy must be an http(s):// or socks5:// URL")
        return value
    if len(value) > spec[1] or any(c in value for c in "\r\n\0"):
        raise ValueError(f"{key} must be a single line of at most {spec[1]} characters")
    return value


def _advanced_public(value):
    out, hidden = {}, []
    for k in _ADVANCED:
        if k not in value:
            continue
        v = value[k]
        if k == "proxy" and isinstance(v, str) and "@" in urlsplit(v).netloc:
            hidden.append(k)  # proxy credentials are never sent to the browser
            continue
        if isinstance(v, (str, int, float, bool)):
            out[k] = v
        else:
            hidden.append(k)
    return out, hidden
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


def _models_url(base):
    """GA endpoint rules (llmcore.auto_make_url) applied to the model list."""
    b = base.strip()
    raw = b.endswith("$")
    b = b.rstrip("$").rstrip("/")
    b = re.sub(r"/(chat/completions|completions|responses|messages)$", "", b)
    if b.endswith("/models"):
        return b
    return f"{b}/models" if raw or re.search(r"/v\d+(/|$)", b) else f"{b}/v1/models"


def _model_ids(payload):
    items = payload.get("data", payload.get("models")) if isinstance(payload, dict) else payload
    if not isinstance(items, list):
        raise ValueError("the provider did not return a model list")
    out = []
    for item in items:
        mid = item.get("id") or item.get("name") if isinstance(item, dict) else item
        if isinstance(mid, str) and mid.strip():
            label = item.get("display_name") if isinstance(item, dict) else None
            out.append({"id": mid.strip(), "name": label if isinstance(label, str) else ""})
    return out


def _fetch_models(base, apikey, protocol, header=None, timeout=20):
    url = _models_url(base)
    headers = {"Accept": "application/json", "User-Agent": "ga-harness"}
    if protocol == "claude":
        headers["anthropic-version"] = "2023-06-01"
        if header == "x-api-key" or (header != "bearer" and apikey.startswith("sk-ant-")):
            headers["x-api-key"] = apikey
        else:
            headers["Authorization"] = f"Bearer {apikey}"
    else:
        headers["Authorization"] = f"Bearer {apikey}"
    found, seen, after = [], set(), None
    for _ in range(20):  # Anthropic paginates; OpenAI-compatible lists return once
        query = {"limit": 1000, **({"after_id": after} if after else {})} if protocol == "claude" else {}
        req = urllib.request.Request(url + ("?" + urlencode(query) if query else ""), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                payload = json.loads(r.read(8 << 20) or b"null")
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read(2000).decode("utf-8", "replace")
            except Exception:
                pass
            detail = re.sub(r"\s+", " ", detail.replace(apikey, "***")).strip()[:200]
            raise ValueError(f"provider returned HTTP {e.code}" + (f": {detail}" if detail else "")) from None
        except (urllib.error.URLError, OSError) as e:
            reason = str(getattr(e, "reason", e)).replace(apikey, "***")[:200]
            raise ValueError(f"could not reach the provider: {reason}") from None
        except ValueError:
            raise ValueError("the provider returned invalid JSON") from None
        for item in _model_ids(payload):
            if item["id"] not in seen:
                seen.add(item["id"])
                found.append(item)
        if not (isinstance(payload, dict) and payload.get("has_more") and payload.get("last_id")):
            break
        after = payload["last_id"]
    return sorted(found, key=lambda x: x["id"].lower())


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


def _mykey_source(original, before, after, filename):
    """Rewrite only changed top-level ``NAME = {...}`` assignments in GA's mykey.py.

    Comments, imports, helper code and untouched configurations keep their
    original text.  Anything not expressible as one plain assignment is refused
    rather than guessed at.
    """
    bom = b"\xef\xbb\xbf" if original.startswith(b"\xef\xbb\xbf") else b""
    text = original.decode("utf-8-sig")
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.splitlines(keepends=True)
    try:
        tree = ast.parse(text, filename)
    except SyntaxError:
        raise ValueError("GA mykey.py has a syntax error; fix it locally before editing") from None
    spans = {}
    for node in tree.body:
        targets = (node.targets if isinstance(node, ast.Assign)
                   else [node.target] if isinstance(node, ast.AnnAssign) else [])
        for t in targets:
            if isinstance(t, ast.Name):
                spans.setdefault(t.id, []).append(node)
    edits, appended = [], []
    for key in sorted(set(before) | set(after)):
        if before.get(key) == after.get(key):
            continue
        nodes = spans.get(key, [])
        if key in before and not nodes:
            raise ValueError(f"{key} is not assigned directly in mykey.py; edit it locally")
        if len(nodes) > 1 or (nodes and (len(getattr(nodes[0], "targets", [0])) != 1 or nodes[0].col_offset)):
            raise ValueError(f"{key} is defined in a complex way in mykey.py; edit it locally")
        tail = ""
        if nodes:
            n = nodes[0]
            try:
                value = ast.literal_eval(n.value)
            except (ValueError, TypeError, SyntaxError):
                raise ValueError(f"{key} is computed dynamically in mykey.py; edit it locally") from None
            if not isinstance(value, dict):
                raise ValueError(f"{key} is not a literal model dictionary; edit it locally")
            tail = lines[n.end_lineno - 1].encode("utf-8")[n.end_col_offset:].decode("utf-8", "replace").strip()
            if tail and not tail.startswith("#"):
                raise ValueError(f"{key} shares a line with other code in mykey.py; edit it locally")
        new = None
        if key in after:
            new = f"{key} = {pprint.pformat(after[key], sort_dicts=False, width=100)}".replace("\n", nl)
            new += ("  " + tail if tail else "") + nl
        if nodes:
            edits.append((nodes[0].lineno - 1, nodes[0].end_lineno, new or ""))
        elif new:
            appended.append(new)
        elif key in before:
            raise ValueError(f"{key} is not assigned directly in mykey.py; edit it locally")
    for start, end, new in sorted(edits, reverse=True):
        lines[start:end] = [new] if new else []
    out = "".join(lines)
    if appended:
        if out and not out.endswith(("\n", "\r")):
            out += nl
        out += "".join(nl + a for a in appended)
    try:
        ns = {"__name__": "mykey", "__file__": filename}
        exec(compile(out, filename, "exec"), ns)
    except Exception:
        raise ValueError("the edited mykey.py would not load; nothing was changed") from None
    for key in set(before) | set(after):
        if before.get(key) == after.get(key):
            continue
        if ns.get(key) != after.get(key):
            raise ValueError("mykey.py computes configurations dynamically; edit it locally") from None
    return bom + out.encode("utf-8")


class Models:
    def __init__(self, agent):
        self.agent = agent
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
        mykey = llmconfig.mykey_path()
        if mykey is None or mykey.suffix.lower() != ".py" or not mykey.is_file():
            raise ValueError("GA mykey.py was not found")
        return mykey

    def _read(self, *, logical=True):
        path = self._file()
        payload = path.read_bytes() if path.exists() else b""
        try:
            data = llmconfig.read_mykey_py(path)
            data.pop("_skipped", None)
        except Exception:
            raise ValueError("mykey.py is invalid; fix it locally before editing") from None
        if logical:
            data = self._mykey_view(data)
        return path, payload, data, hashlib.sha256(payload).hexdigest()

    def _mykey_view(self, data):
        """Expose native ownership without mutating GA's imported model dictionaries."""
        out = dict(data)
        owners = out.pop(llmconfig.MYKEY_MODEL_PROVIDERS, {})
        providers = self._providers(out)
        if not isinstance(owners, dict):
            raise ValueError("mykey provider mapping is invalid; fix it locally before editing")
        for key, pid in owners.items():
            if (not isinstance(key, str) or not _supported(key, out.get(key))
                    or not isinstance(pid, str) or pid not in providers
                    or out[key].get("provider", pid) != pid):
                raise ValueError("mykey provider mapping is invalid; fix it locally before editing")
            out[key] = dict(out[key], provider=pid)
        return out

    def _mykey_data(self, data):
        """Persist standalone-GA dictionaries; ownership lives outside model kwargs."""
        out, owners = dict(data), {}
        providers = self._providers(data)
        for key, value in data.items():
            if _supported(key, value) and "provider" in value:
                owners[key] = value["provider"]
                try:
                    out[key] = llmconfig.resolve_providers({llmconfig.PROVIDERS: providers, key: value})[key]
                except llmconfig.ConfigError as e:
                    raise ValueError(str(e)) from None
        if owners:
            out[llmconfig.MYKEY_MODEL_PROVIDERS] = owners
        return out

    def _providers(self, data):
        p = data.get(llmconfig.PROVIDERS, {})
        if not isinstance(p, dict) or any(not isinstance(v, dict) for v in p.values()):
            raise ValueError("providers table is invalid; fix it locally before editing")
        return p

    def _group_of(self):
        """Runtime identity -> ordered provider labels, never credentials.

        Ungrouped entries use the same base URL + key grouping as migration.
        Explicit provider IDs remain authoritative, even with duplicate names.
        """
        try:
            data = self._mykey_view(vars(sys.modules.get("mykey")))
            providers = self._providers(data)
            legacy = llmconfig.group_providers({k: v for k, v in data.items()
                                               if _supported(k, v) and "provider" not in v})
        except Exception:
            return {}
        out = {}
        for k, v in data.items():
            if not _supported(k, v):
                continue
            pid = v.get("provider")
            pv = providers.get(pid) if isinstance(pid, str) else None
            group_id = "provider:" + pid if pv is not None else None
            if pv is None:
                pid = legacy.get(k, {}).get("provider")
                pv = legacy.get(llmconfig.PROVIDERS, {}).get(pid)
                group_id = "legacy:" + pid if pv is not None else None
            label = (pv.get("name") or pid) if pv is not None else None
            try:
                name = llmconfig._expand(v.get("name") or v.get("model", ""))
                model = llmconfig._expand(v.get("model", ""))
            except llmconfig.ConfigError:
                continue
            out.setdefault((name, model), []).append((group_id, label))
        return out

    def catalog(self):
        rows = []
        current = None
        groups = self._group_of()
        for i, c in enumerate(self.agent.llmclients):
            b = getattr(c, "backend", None)
            if b is None:
                continue
            name = getattr(b, "name", "") or getattr(b, "model", "")
            model = getattr(b, "model", "")
            matches = groups.get((name, model), [])
            pid, label = matches.pop(0) if matches else (None, None)
            rows.append({"id": i, "name": name, "model": model,
                         "provider": label, "provider_id": pid})
            if c is self.agent.llmclient:
                current = i
        return {"items": rows, "current": current}

    def remote(self, body):
        """List model IDs offered by a provider. Stored keys are used server-side only.

        Source: an existing provider (`provider`) or model (`key`); unsaved form
        values `apibase` / `apikey` / `protocol` override it (empty key keeps the stored one).
        """
        with self.lock:
            _, _, data, _ = self._read()
            providers = self._providers(data)
            pid, key, src = body.get("provider"), body.get("key"), {}
            if pid:
                if not isinstance(pid, str) or pid not in providers:
                    raise ValueError("unknown provider")
                src = dict(providers[pid])
            elif key:
                if not isinstance(key, str) or not _supported(key, data.get(key)):
                    raise ValueError("unknown model configuration")
                try:
                    src = llmconfig.resolve_providers({llmconfig.PROVIDERS: providers, key: data[key]})[key]
                except llmconfig.ConfigError as e:
                    raise ValueError(str(e)) from None
        protocol = body.get("protocol") or src.get("protocol") or (_protocol(key) if isinstance(key, str) and key else "oai")
        if protocol not in _PROTOCOLS:
            raise ValueError("protocol must be oai or claude")
        base, apikey = src.get("apibase"), src.get("apikey")
        for k in ("apibase", "apikey"):
            v = body.get(k)
            if isinstance(v, str) and v.strip():
                if k == "apibase":
                    base = v.strip()
                else:
                    apikey = v.strip()
        if not isinstance(base, str) or not base.strip() or not isinstance(apikey, str) or not apikey.strip():
            raise ValueError("base URL and API key are required")
        try:
            base, apikey = llmconfig._expand(base), llmconfig._expand(apikey)
        except Exception:
            raise ValueError("a referenced environment variable is not configured") from None
        if not _safe_url(base.rstrip("$")):
            raise ValueError("base URL must be HTTP(S), without credentials, query or fragment")
        header = src.get("api_key_header")
        return {"models": _fetch_models(base, apikey, protocol, header if isinstance(header, str) else None)}

    def config(self):
        with self.lock:
            try:
                _, _, data, revision = self._read()
                providers = self._providers(data)
            except ValueError as e:
                return {"writable": False, "reason": str(e), "entries": [], "providers": []}
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
                options, opt_hidden = _advanced_public(value)
                entries.append({"key": key, "values": public, "provider": pid, "protocol": _protocol(key),
                                "has_key": bool(value.get("apikey")), "url_hidden": hidden,
                                "options": options, "options_hidden": opt_hidden})
            plist = []
            for pid, pv in providers.items():
                url, hidden = _public_url(pv.get("apibase", ""))
                values = {"name": pv.get("name", ""), "protocol": pv.get("protocol", "oai")}
                if url is not None:
                    values["apibase"] = url
                plist.append({"id": pid, "values": values, "has_key": bool(pv.get("apikey")),
                              "url_hidden": hidden, "models": count.get(pid, 0)})
            return {"writable": True, "revision": revision, "entries": entries, "providers": plist,
                    "format": "mykey"}

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
            if not isinstance(cfg.get("name", ""), str) or len(cfg.get("name", "")) > 120:
                raise ValueError("name must contain at most 120 characters")
            if any(not isinstance(cfg.get(k), str) or not cfg[k].strip() for k in ("apibase", "apikey")):
                raise ValueError("base URL and API key are required")
            _check_url(cfg["apibase"])
            providers[pid] = cfg
            # Native models carry concrete connection settings, not provider kwargs.
            # Only share credentials: each model keeps its own protocol and options.
            for key in used:
                data[key] = dict(data[key], apibase=cfg["apibase"], apikey=cfg["apikey"])
        if providers:
            data[llmconfig.PROVIDERS] = providers
        else:
            data.pop(llmconfig.PROVIDERS, None)
        return bool(used)

    def _provider_group(self, data):
        """Lift ungrouped models sharing an identical base URL + key into providers.

        Only literal-equal apibase/apikey pairs are grouped (protocol stays per model);
        an existing provider with the same pair is reused. Resolved models must not change.
        """
        providers = {pid: dict(p) for pid, p in self._providers(data).items()}  # never mutate live mykey dicts
        data[llmconfig.PROVIDERS] = providers
        try:
            before = llmconfig.resolve_providers(data)
        except llmconfig.ConfigError as e:
            raise ValueError(str(e)) from None
        same = {}
        for pid, p in providers.items():
            if isinstance(p.get("apibase"), str) and isinstance(p.get("apikey"), str):
                same.setdefault((p["apibase"], p["apikey"]), pid)
        groups = {}
        for k, v in data.items():
            if not _supported(k, v) or "provider" in v:
                continue
            base, key = v.get("apibase"), v.get("apikey")
            if isinstance(base, str) and base.strip() and isinstance(key, str) and key.strip():
                groups.setdefault((base, key), []).append(k)
        if not groups:
            raise ValueError("no ungrouped model has both a base URL and an API key")
        taken = set(providers)
        names = {p.get("name") for p in providers.values()}
        for (base, key), keys in groups.items():
            pid = same.get((base, key))
            if pid is None:
                pid = llmconfig._provider_id(base, taken)
                try:
                    host = urlsplit(llmconfig._expand(base)).hostname or pid
                except Exception:
                    host = pid
                name, n = host, 2
                while name in names:
                    name, n = f"{host} ({n})", n + 1
                names.add(name)
                providers[pid] = {"name": name, "protocol": _protocol(keys[0]), "apibase": base, "apikey": key}
            for k in keys:
                data[k] = dict(data[k], provider=pid)  # native mykey keeps concrete values
        try:
            after = llmconfig.resolve_providers(data)
        except llmconfig.ConfigError:
            after = None
        if after != before:
            raise ValueError("grouping would change a model's connection; nothing was changed")
        return False

    def change(self, body):
        with self.lock:
            self._idle()
            path, original, data, revision = self._read(logical=False)
            if body.get("revision") != revision:
                raise RuntimeError("model file changed; reload settings before saving")
            action = body.get("action")
            before = copy.deepcopy(data)
            data = self._mykey_view(data)
            expanded = None
            if action in ("provider_save", "provider_delete"):
                affects_models = self._provider_change(data, action, body)
            elif action == "provider_group":
                affects_models = self._provider_group(data)
            elif action == "save_many":
                affects_models, expanded = True, []
                items = body.get("items")
                if not isinstance(items, list) or not 0 < len(items) <= 200:
                    raise ValueError("add between 1 and 200 models at once")
                for item in items:
                    key = item.get("key") if isinstance(item, dict) else None
                    if not isinstance(key, str) or not _KEY.fullmatch(key):
                        raise ValueError("invalid configuration identifier")
                    if key in data:
                        raise ValueError("configuration identifier already exists")
                    expanded.append(self._model_save(data, key, item))
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
            payload = _mykey_source(original, before, self._mykey_data(data), str(path))
            agent = self.agent
            old = agent.llmclients, agent.llmclient, getattr(agent, "llm_no", 0)
            try:
                _replace(path, payload)
                llmconfig.refresh_mykey()
                if affects_models:
                    agent.load_llm_sessions()
                    if not agent.llmclients or any(not hasattr(c, "backend") for c in agent.llmclients):
                        raise RuntimeError()
                    for item in ([] if expanded is None else expanded if isinstance(expanded, list) else [expanded]):
                        wanted = item.get("name") or item["model"]
                        if not any(c.backend.name == wanted and c.backend.model == item["model"] for c in agent.llmclients):
                            raise RuntimeError()
            except Exception:
                _replace(path, original)
                llmconfig.refresh_mykey()
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
        options = body.get("options") or {}
        if not isinstance(values, dict) or set(values) - set(_FIELDS) - {"apikey", "provider"}:
            raise ValueError("invalid model fields")
        if not isinstance(options, dict) or set(options) - set(_ADVANCED):
            raise ValueError("invalid model options")
        for k, v in options.items():
            if v is None or (isinstance(v, str) and not v.strip()):
                cfg.pop(k, None)
            else:
                cfg[k] = _advanced_value(k, v)
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
