"""Loader: manifests + profiles + layered patches -> resolved plugin tree.

Manifest  <plugin_dir>/plugin.toml
    name = "tool-code-run"
    entry = "main:apply"          # module (relative to plugin dir package) : attr
    inject = ["tools"]
    provides = []

Profile   <profiles_dir>/<name>.toml
    extends = "base"              # optional, resolved recursively
    [[plugins]]                   # appended in order (same name -> replaced in place)
    name = "llm-ga"
    config = { model = "x" }
    [[patch]]                     # applied after this profile's plugins
    id = "telemetry-langfuse"
    disabled = true

Patch ops (dicts):  {id, disabled}  {id, config}(deep-merged)  {insert:{name,config}, before|after}
                    {remove: id}
Final order: profile chain -> user patch files -> CLI patches.
"""
from __future__ import annotations
import copy
import importlib
import importlib.util
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .plugin import Plugin, Runtime


@dataclass
class Manifest:
    name: str
    entry: str
    path: Path
    inject: list[str] = field(default_factory=list)
    provides: list[str] = field(default_factory=list)
    description: str = ""

    def load_apply(self) -> Callable:
        mod_name, _, attr = self.entry.partition(":")
        attr = attr or "apply"
        pkg = "ga_harness_ext_" + self.name.replace("-", "_")
        if pkg not in sys.modules:
            spec = importlib.util.spec_from_file_location(
                pkg, self.path / "__init__.py", submodule_search_locations=[str(self.path)])
            module = importlib.util.module_from_spec(spec)
            sys.modules[pkg] = module
            if (self.path / "__init__.py").exists():
                spec.loader.exec_module(module)
        mod = importlib.import_module(f"{pkg}.{mod_name}")
        return getattr(mod, attr)

    def to_plugin(self) -> Plugin:
        return Plugin(self.name, self.load_apply(), list(self.inject), list(self.provides))


def discover(dirs: list[Path | str]) -> dict[str, Manifest]:
    found: dict[str, Manifest] = {}
    for d in dirs:
        d = Path(d)
        if not d.is_dir():
            continue
        for mf in sorted(d.glob("*/plugin.toml")):
            data = tomllib.loads(mf.read_text(encoding="utf-8"))
            m = Manifest(name=data["name"], entry=data.get("entry", "main:apply"), path=mf.parent,
                         inject=list(data.get("inject", [])), provides=list(data.get("provides", [])),
                         description=data.get("description", ""))
            found[m.name] = m  # later dirs override earlier ones
    return found


def deep_merge(base: Any, over: Any) -> Any:
    if isinstance(base, dict) and isinstance(over, dict):
        out = dict(base)
        for k, v in over.items():
            out[k] = deep_merge(base.get(k), v) if k in base else copy.deepcopy(v)
        return out
    return copy.deepcopy(over)


def _entry(spec: dict) -> dict:
    return {"name": spec["name"], "config": copy.deepcopy(spec.get("config", {})),
            "disabled": bool(spec.get("disabled", False))}


def _index(tree: list[dict], name: str) -> int:
    for i, e in enumerate(tree):
        if e["name"] == name:
            return i
    raise KeyError(f"patch target {name!r} not in plugin tree")


def apply_patch(tree: list[dict], op: dict) -> list[dict]:
    tree = [dict(e) for e in tree]
    if "insert" in op:
        e = _entry(op["insert"])
        if any(x["name"] == e["name"] for x in tree):
            raise KeyError(f"insert: {e['name']!r} already in tree")
        if "before" in op:
            tree.insert(_index(tree, op["before"]), e)
        elif "after" in op:
            tree.insert(_index(tree, op["after"]) + 1, e)
        else:
            tree.append(e)
    elif "remove" in op:
        tree.pop(_index(tree, op["remove"]))
    elif "id" in op:
        i = _index(tree, op["id"])
        if "disabled" in op:
            tree[i]["disabled"] = bool(op["disabled"])
        if "config" in op:
            tree[i]["config"] = deep_merge(tree[i]["config"], op["config"])
    else:
        raise ValueError(f"unknown patch op: {op}")
    return tree


def resolve_profile(name: str, profile_dirs: list[Path | str], _seen: tuple = ()) -> list[dict]:
    if name in _seen:
        raise ValueError(f"profile extends cycle: {' -> '.join(_seen + (name,))}")
    path = next((Path(d) / f"{name}.toml" for d in reversed(profile_dirs)
                 if (Path(d) / f"{name}.toml").exists()), None)
    if path is None:
        raise FileNotFoundError(f"profile {name!r} not found in {profile_dirs}")
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    tree = resolve_profile(data["extends"], profile_dirs, _seen + (name,)) if data.get("extends") else []
    for spec in data.get("plugins", []):
        e = _entry(spec)
        idx = next((i for i, x in enumerate(tree) if x["name"] == e["name"]), None)
        if idx is None:
            tree.append(e)
        else:
            tree[idx] = e
    for op in data.get("patch", []):
        tree = apply_patch(tree, op)
    return tree


def load_patch_file(path: Path | str) -> list[dict]:
    return list(tomllib.loads(Path(path).read_text(encoding="utf-8")).get("patch", []))


def build_tree(profile: str, profile_dirs, patch_files=(), cli_patches=()) -> list[dict]:
    tree = resolve_profile(profile, list(profile_dirs))
    for pf in patch_files:
        for op in load_patch_file(pf):
            tree = apply_patch(tree, op)
    for op in cli_patches:
        tree = apply_patch(tree, op)
    return tree


def mount(runtime: Runtime, tree: list[dict], manifests: dict[str, Manifest]) -> list[str]:
    """Add every enabled entry to the runtime. Returns names that were mounted."""
    mounted = []
    for e in tree:
        if e["disabled"]:
            continue
        if e["name"] not in manifests:
            raise KeyError(f"plugin {e['name']!r} has no manifest")
        runtime.add(manifests[e["name"]].to_plugin(), e["config"])
        mounted.append(e["name"])
    return mounted
