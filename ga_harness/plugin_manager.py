"""Local plugin preferences, independent of any frontend.

Only manifest-declared public fields are exposed. Changes are staged for the
next launch; this module never imports or unloads a plugin to inspect it.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import tempfile
import threading
from pathlib import Path

HOST_CAPABILITIES = {"plugin.catalog"}
PROTECTED = {"plugin-manager", "ga-core", "llm-config"}
SENSITIVE = re.compile(r"key|secret|password|token|credential|authorization", re.I)
MAX_FILE = 1 << 20


def settings_path():
    return Path(os.environ.get("GAH_PLUGIN_CONFIG") or Path.home() / ".ga-harness" / "plugins.json").expanduser()


def protected(manifest):
    return manifest.name in PROTECTED or bool(set(manifest.provides) & {"agent", "frontend", "plugin.manager", "plugin.catalog"})


def public_fields(manifest):
    return {k: v for k, v in manifest.settings.items()
            if isinstance(v, dict) and v.get("type") in {"string", "integer", "boolean"}
            and not v.get("secret") and not SENSITIVE.search(k)}


def validate_values(manifest, values):
    if not isinstance(values, dict):
        raise ValueError("config must be an object")
    fields = public_fields(manifest)
    for key, value in values.items():
        spec = fields.get(key)
        if spec is None:
            raise ValueError("configuration field is not publicly editable")
        kind = spec["type"]
        valid = ((kind == "string" and isinstance(value, str) and len(value) <= min(spec.get("max_length", 8000), 8000))
                 or (kind == "integer" and type(value) is int and spec.get("min", -1000000) <= value <= spec.get("max", 1000000))
                 or (kind == "boolean" and type(value) is bool))
        if not valid:
            raise ValueError(f"invalid value for {key}")
    return copy.deepcopy(values)


class PluginPreferences:
    def __init__(self, path, profile, manifests, baseline):
        self.path = Path(path)
        self.profile = profile
        self.manifests = manifests
        self.baseline = copy.deepcopy(baseline)
        self.lock = threading.RLock()

    def read(self):
        try:
            with self.path.open("rb") as f:
                raw = f.read(MAX_FILE + 1)
        except FileNotFoundError:
            raw = b""
        if len(raw) > MAX_FILE:
            raise ValueError("plugin settings file is too large")
        try:
            data = json.loads(raw) if raw else {"version": 1, "profiles": {}}
            if data.get("version") != 1 or not isinstance(data.get("profiles"), dict):
                raise ValueError()
            for entries in data["profiles"].values():
                if not isinstance(entries, dict):
                    raise ValueError()
                for item in entries.values():
                    if (not isinstance(item, dict) or set(item) - {"enabled", "config"}
                            or ("enabled" in item and type(item["enabled"]) is not bool)
                            or not isinstance(item.get("config", {}), dict)):
                        raise ValueError()
        except (ValueError, AttributeError, TypeError):
            raise ValueError("invalid plugin settings; repair the local file before saving") from None
        return data, hashlib.sha256(raw).hexdigest()

    def resolve(self, data):
        tree = copy.deepcopy(self.baseline)
        entries = {e["name"]: e for e in tree}
        for name, patch in data["profiles"].get(self.profile, {}).items():
            manifest = self.manifests.get(name)
            if manifest is None:
                continue  # keep preferences for temporarily absent plugin directories
            if protected(manifest):
                raise ValueError("protected plugins cannot be overridden by plugin settings")
            values = validate_values(manifest, patch.get("config", {}))
            if name not in entries:
                entries[name] = {"name": name, "disabled": True, "config": {}}
                index = next((i for i, e in enumerate(tree) if "frontend" in self.manifests[e["name"]].provides), len(tree))
                tree.insert(index, entries[name])
            entry = entries[name]
            if "enabled" in patch:
                entry["disabled"] = not patch["enabled"]
            entry["config"].update(values)
        return tree

    def issues(self, tree):
        enabled = {e["name"] for e in tree if not e["disabled"]}
        available = set(HOST_CAPABILITIES)
        ready = set()
        while True:
            found = {name for name in enabled - ready if name in self.manifests and
                     all(cap.endswith("?") or cap in available for cap in self.manifests[name].inject)}
            if not found:
                break
            ready.update(found)
            for name in found:
                available.update(self.manifests[name].provides)
        issues = []
        for name in sorted(enabled - ready):
            m = self.manifests.get(name)
            missing = [c for c in m.inject if not c.endswith("?") and c not in available] if m else ["manifest"]
            issues.append(f"{name}: missing {', '.join(missing)}")
        owners = {}
        for name in sorted(enabled):
            m = self.manifests.get(name)
            for cap in m.provides if m else []:
                if cap in owners:
                    issues.append(f"{name}: {cap} conflicts with {owners[cap]}")
                owners[cap] = name
        return issues

    def write(self, data):
        raw = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        if len(raw) > MAX_FILE:
            raise ValueError("plugin settings file is too large")
        fd, tmp = tempfile.mkstemp(prefix=".plugins-", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(raw)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)


class PluginManager:
    def __init__(self, ctx, preferences, running_tree):
        self.ctx = ctx
        self.preferences = preferences
        self.running_tree = copy.deepcopy(running_tree)

    def catalog(self):
        p = self.preferences
        with p.lock:
            data, revision = p.read()
            desired = {e["name"]: e for e in p.resolve(data)}
            running = {e["name"]: e for e in self.running_tree}
            items = []
            for name, m in sorted(p.manifests.items()):
                absent = {"name": name, "disabled": True, "config": {}}
                target, current = desired.get(name, absent), running.get(name, absent)
                h = self.ctx.runtime.handles.get(name)
                fields = public_fields(m) if not protected(m) else {}
                values = {}
                for key, spec in fields.items():
                    value = target["config"].get(key, spec.get("default"))
                    try:
                        values.update(validate_values(m, {key: value}))
                    except ValueError:
                        pass
                pending = target["disabled"] != current["disabled"] or target["config"] != current["config"]
                items.append({"name": name, "description": m.description,
                              "state": h.state if h else "disabled",
                              "error": "plugin activation failed; see local logs" if h and h.error else None,
                              "enabled": not target["disabled"], "restart_required": pending,
                              "protected": protected(m), "fields": fields, "config": values,
                              "requires": m.inject, "provides": m.provides,
                              "missing": [c for c in m.inject if not c.endswith("?") and not self.ctx.has(c)],
                              "dependents": sorted(n for n, other in p.manifests.items()
                                                   if n != name and n in desired and not desired[n]["disabled"]
                                                   and set(other.inject) & set(m.provides)),
                              "overridden": name in data["profiles"].get(p.profile, {})})
            return {"items": items, "revision": revision, "profile": p.profile,
                    "restart_required": any(i["restart_required"] for i in items),
                    "issues": p.issues(list(desired.values()))}

    def change(self, body):
        p = self.preferences
        with p.lock:
            name = body.get("name")
            if not isinstance(name, str) or name not in p.manifests:
                raise ValueError("unknown plugin")
            if protected(p.manifests[name]):
                raise ValueError("this plugin is protected; use startup configuration")
            action = body.get("action", "save")
            if action not in {"save", "reset"}:
                raise ValueError("unknown plugin action")
            p.path.parent.mkdir(parents=True, exist_ok=True)
            lock_path = p.path.with_name(p.path.name + ".lock")
            try:
                fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                raise RuntimeError("plugin settings are locked by another writer") from None
            try:
                os.close(fd)
                data, revision = p.read()
                if body.get("revision") != revision:
                    raise RuntimeError("plugin settings changed; reload before saving")
                entries = data["profiles"].setdefault(p.profile, {})
                if action == "reset":
                    entries.pop(name, None)
                else:
                    if type(body.get("enabled")) is not bool:
                        raise ValueError("enabled must be a boolean")
                    values = validate_values(p.manifests[name], body.get("config", {}))
                    entries[name] = {"enabled": body["enabled"], "config": values}
                issues = p.issues(p.resolve(data))
                if issues:
                    raise RuntimeError("dependency check failed: " + "; ".join(issues))
                p.write(data)
                return self.catalog()
            finally:
                lock_path.unlink()
