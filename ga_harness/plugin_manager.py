"""Local plugin preferences, independent of any frontend.

Only manifest-declared public fields are exposed. Changes are staged for the
next launch, except for "hot" plugins (installed in the user plugin directory and
not hosting core capabilities), which are unmounted/remounted in place after a
successful save. Inspection never imports or unloads a plugin.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import sys
import tempfile
import threading
from pathlib import Path

from .packages import install as install_packages, missing as missing_packages

HOST_CAPABILITIES = {"plugin.catalog"}
PROTECTED = {"plugin-manager", "ga-core"}
SENSITIVE = re.compile(r"key|secret|password|token|credential|authorization", re.I)
MAX_FILE = 1 << 20


def settings_path():
    return Path(os.environ.get("GAH_PLUGIN_CONFIG") or Path.home() / ".ga-harness" / "plugins.json").expanduser()


def frontend_capabilities(manifests):
    """Capabilities only a frontend provides (e.g. ``web.host``). Plugins that need one of these
    are add-ons for that frontend: when another frontend is selected they stay dormant."""
    return {cap for m in manifests.values() if "frontend" in m.provides
            for cap in m.provides if cap != "frontend"}


# Capabilities whose owners cannot be swapped while the host is running.
HOST_ONLY = {"agent", "frontend", "web.host", "sessions", "runs", "workspaces", "models",
             "plugin.manager", "plugin.catalog"}


def user_plugin_dir():
    return (Path.home() / ".ga-harness" / "plugins").resolve()


def hot_capable(manifest):
    """True if the plugin can be (un)mounted at runtime without a restart."""
    if protected(manifest) or set(manifest.provides) & HOST_ONLY:
        return False
    try:
        return Path(manifest.path).resolve().is_relative_to(user_plugin_dir())
    except (OSError, TypeError, ValueError):
        return False


def purge_modules(name):
    pkg = "ga_harness_ext_" + name.replace("-", "_")
    for key in [k for k in sys.modules if k == pkg or k.startswith(pkg + ".")]:
        del sys.modules[key]


def protected(manifest):
    return manifest.name in PROTECTED or bool(set(manifest.provides) & {"agent", "frontend", "plugin.manager", "plugin.catalog"})


def choice_options(spec):
    """Normalise ``options`` of a choice field to ``[{value, label, label_zh}]``; None if malformed."""
    raw = spec.get("options")
    if not isinstance(raw, list) or not raw:
        return None
    out = []
    for o in raw:
        o = {"value": o} if isinstance(o, str) else o
        if not isinstance(o, dict) or not isinstance(o.get("value"), str):
            return None
        out.append({"value": o["value"], "label": str(o.get("label") or o["value"]),
                    "label_zh": str(o.get("label_zh") or "")})
    return out if len({o["value"] for o in out}) == len(out) else None


def public_fields(manifest):
    fields = {}
    for k, v in manifest.settings.items():
        if not isinstance(v, dict) or v.get("secret") or SENSITIVE.search(k):
            continue
        if v.get("type") in {"string", "integer", "boolean"}:
            fields[k] = v
        elif v.get("type") == "choice" and (options := choice_options(v)):
            fields[k] = {**v, "options": options}
    return fields


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
                 or (kind == "boolean" and type(value) is bool)
                 or (kind == "choice" and isinstance(value, str) and value in {o["value"] for o in spec["options"]}))
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
        dormant = frontend_capabilities(self.manifests)
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
            if m and missing and set(missing) <= dormant:
                continue    # add-on for a frontend that is not selected: dormant, not broken
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
                pending = (target["disabled"] != current["disabled"] or target["config"] != current["config"]
                           or (not current["disabled"] and h is None and name in getattr(
                               self.ctx.runtime, "unmet_packages", {})))
                lack = missing_packages(getattr(m, "packages", []))
                items.append({"name": name, "description": m.description,
                              "description_zh": getattr(m, "description_zh", ""),
                              "category": getattr(m, "category", "other"),
                              "state": h.state if h else ("missing_packages" if lack and not current["disabled"]
                                                          else "disabled"),
                              "packages": list(getattr(m, "packages", [])), "missing_packages": lack,
                              "error": "plugin activation failed; see local logs" if h and h.error else None,
                              "enabled": not target["disabled"], "restart_required": pending,
                              "protected": protected(m), "hot": hot_capable(m),
                              "fields": fields, "config": values,
                              "requires": m.inject, "provides": m.provides,
                              "missing": [c for c in m.inject if not c.endswith("?") and not self.ctx.has(c)],
                              "dependents": sorted(n for n, other in p.manifests.items()
                                                   if n != name and n in desired and not desired[n]["disabled"]
                                                   and set(other.inject) & set(m.provides)),
                              "overridden": name in data["profiles"].get(p.profile, {})})
            return {"items": items, "revision": revision, "profile": p.profile,
                    "restart_required": any(i["restart_required"] for i in items),
                    "issues": p.issues(list(desired.values()))}

    _install_lock = threading.Lock()

    def install(self, body):
        """Install a plugin's declared ``packages`` (explicit user action).

        Takes effect on the next start, like every other plugin change.
        """
        name = body.get("name") if isinstance(body, dict) else None
        m = self.preferences.manifests.get(name) if isinstance(name, str) else None
        if m is None:
            raise ValueError("unknown plugin")
        lack = missing_packages(getattr(m, "packages", []))
        if not lack:
            return {"ok": True, "output": "", "catalog": self.catalog()}
        if not self._install_lock.acquire(blocking=False):
            raise RuntimeError("another package installation is running")
        try:
            result = install_packages(lack)
        finally:
            self._install_lock.release()
        return {"ok": result["ok"], "output": result["output"], "catalog": self.catalog()}

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
            finally:
                lock_path.unlink()
            result = {}
            if hot_capable(p.manifests[name]):
                entry = next((e for e in p.resolve(data) if e["name"] == name),
                             {"name": name, "disabled": True, "config": {}})
                try:
                    self._hot_apply(name, entry)
                    result["applied"] = True
                except Exception as error:  # keep secrets out: report the class only
                    result["applied"] = False
                    result["hot_error"] = f"hot apply failed ({type(error).__name__}); restart to apply"
            return {**self.catalog(), **result}

    def _hot_apply(self, name, entry):
        """Unmount ``name`` and remount it from disk with ``entry``'s config."""
        rt = self.ctx.runtime
        m = self.preferences.manifests[name]
        unmet = getattr(rt, "unmet_packages", None)
        if unmet is None:
            unmet = rt.unmet_packages = {}
        if name in rt.handles:
            rt.remove(name)
        purge_modules(name)
        unmet.pop(name, None)
        running = {"name": name, "disabled": entry["disabled"], "config": copy.deepcopy(entry["config"])}
        try:
            if not entry["disabled"]:
                lack = missing_packages(getattr(m, "packages", []))
                if lack:
                    unmet[name] = lack
                else:
                    rt.add(m.to_plugin(), copy.deepcopy(entry["config"]))
        finally:
            for i, e in enumerate(self.running_tree):
                if e["name"] == name:
                    self.running_tree[i] = {**e, **running}
                    break
            else:
                self.running_tree.append(running)

    def rescan(self):
        """Pick up plugins added to (or edited in) the user plugin directory."""
        from .kernel.loader import discover
        p = self.preferences
        with p.lock:
            for name, m in discover([user_plugin_dir()]).items():
                old = p.manifests.get(name)
                if old is None or hot_capable(old):
                    p.manifests[name] = m
        return self.catalog()

    def agent_control(self, body):
        """Small, revision-free surface for the agent: list / enable / disable / rescan.

        Only hot-capable (user directory) plugins can be toggled, so the agent can never
        disable core/host plugins or leave the host waiting for a restart.
        """
        body = body if isinstance(body, dict) else {}
        action = body.get("action", "list")
        if action == "rescan":
            catalog = self.rescan()
        elif action in {"enable", "disable"}:
            name = body.get("name")
            m = self.preferences.manifests.get(name) if isinstance(name, str) else None
            if m is None:
                raise ValueError("unknown plugin")
            if not hot_capable(m):
                raise ValueError("only plugins in ~/.ga-harness/plugins can be toggled at runtime")
            current = next(i for i in self.catalog()["items"] if i["name"] == name)
            catalog = self.change({"name": name, "action": "save", "enabled": action == "enable",
                                   "config": current["config"], "revision": self.catalog()["revision"]})
        elif action == "list":
            catalog = self.catalog()
        else:
            raise ValueError("unknown action; use list, enable, disable or rescan")
        items = [{k: i[k] for k in ("name", "category", "state", "enabled", "hot", "restart_required",
                                    "description", "missing_packages")} for i in catalog["items"]]
        out = {"items": items, "issues": catalog["issues"]}
        for k in ("applied", "hot_error"):
            if k in catalog:
                out[k] = catalog[k]
        return out
