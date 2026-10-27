"""Agent presets: named, per-session adjustments to an isolated worker run.

A preset is a TOML file in the built-in ``ga_harness/presets/`` directory or in
``~/.ga-harness/presets/`` (user files override built-ins with the same id).
Fields (all optional except a usable file stem as id)::

    name / name_zh               display name
    description / description_zh
    prompt = "..."               appended to the system prompt (ga-prompt ``append``)
    disable_tools = ["..."]      merged into ga-tools ``disable``
    [config.<plugin>]            shallow-merged into the config of a plugin that is
                                 already part of the worker recipe

Presets never add or remove plugins and cannot touch protected plugins.
"""
from __future__ import annotations

import copy
import re
import tomllib
from pathlib import Path

BUILTIN_DIR = Path(__file__).with_name("presets")
USER_DIR = Path.home() / ".ga-harness" / "presets"
PROTECTED = frozenset(("ga-core", "llm-config", "ga-hooks", "ga-events", "ga-stdout"))
_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def _parse(path):
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    tools = data.get("disable_tools", [])
    if not isinstance(tools, list) or not all(isinstance(t, str) for t in tools):
        raise ValueError("disable_tools must be a list of strings")
    if not isinstance(data.get("prompt", ""), str):
        raise ValueError("prompt must be a string")
    config = data.get("config", {})
    if not isinstance(config, dict) or not all(isinstance(v, dict) for v in config.values()):
        raise ValueError("config must be a table of plugin tables")
    bad = PROTECTED & set(config)
    if bad:
        raise ValueError("protected plugins cannot be configured: " + ", ".join(sorted(bad)))
    return {"id": path.stem, "name": str(data.get("name") or path.stem),
            "name_zh": str(data.get("name_zh") or ""),
            "description": str(data.get("description") or ""),
            "description_zh": str(data.get("description_zh") or ""),
            "prompt": data.get("prompt", ""), "disable_tools": list(tools), "config": config,
            "builtin": path.parent == BUILTIN_DIR}


def load(dirs=None):
    """Return {id: preset}; invalid files are skipped and reported under ``errors``."""
    presets, errors = {}, {}
    for folder in dirs or (BUILTIN_DIR, USER_DIR):
        folder = Path(folder)
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("*.toml")):
            if not _ID.match(path.stem):
                errors[path.name] = "invalid preset id"
                continue
            try:
                presets[path.stem] = _parse(path)
            except Exception as e:  # noqa: BLE001 - surfaced to the UI, never fatal
                errors[path.name] = str(e)
    return presets, errors


def catalog(current=None, dirs=None):
    presets, errors = load(dirs)
    items = [{k: p[k] for k in ("id", "name", "name_zh", "description", "description_zh", "builtin")}
             for p in presets.values()]
    return {"current": current if current in presets else None, "items": items, "errors": errors}


def get(preset_id, dirs=None):
    if not preset_id:
        return None
    presets, _ = load(dirs)
    return presets.get(preset_id)


def apply(recipe, preset):
    """Return a new recipe with ``preset`` applied; raises if a needed plugin is absent."""
    if not preset:
        return recipe
    recipe = [(manifest, copy.deepcopy(config)) for manifest, config in recipe]
    configs = {manifest.name: config for manifest, config in recipe}

    def need(name):
        if name not in configs:
            raise ValueError(f"preset {preset['id']!r} needs plugin {name!r} to be active")
        return configs[name]

    if preset.get("prompt"):
        config = need("ga-prompt")
        old = config.get("append", "")
        config["append"] = (old + "\n\n" if old else "") + preset["prompt"]
    if preset.get("disable_tools"):
        config = need("ga-tools")
        disabled = list(config.get("disable", []))
        config["disable"] = disabled + [t for t in preset["disable_tools"] if t not in disabled]
    for name, values in (preset.get("config") or {}).items():
        if name in PROTECTED:
            raise ValueError(f"protected plugin {name!r} cannot be configured")
        need(name).update(copy.deepcopy(values))
    return recipe
