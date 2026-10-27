"""Python package requirements declared by plugins (``packages = [...]``).

``missing`` checks the running interpreter; ``install`` installs into it with
uv when available, else pip. Nothing here runs automatically: installing is
an explicit user action from the plugin manager.
"""
from __future__ import annotations

import importlib.metadata as md
import re
import shutil
import subprocess
import sys

_NAME = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)")


def _satisfied(spec: str) -> bool:
    try:
        from packaging.requirements import Requirement
    except ImportError:
        Requirement = None
    if Requirement is None:
        m = _NAME.match(spec)
        if not m:
            return False
        try:
            md.version(m.group(1))
            return True
        except md.PackageNotFoundError:
            return False
    req = Requirement(spec)
    if req.marker is not None and not req.marker.evaluate():
        return True
    try:
        version = md.version(req.name)
    except md.PackageNotFoundError:
        return False
    return not req.specifier or req.specifier.contains(version, prereleases=True)


def valid(spec) -> bool:
    """A requirement string, never an installer option or a path/URL."""
    return (isinstance(spec, str) and bool(_NAME.match(spec)) and not spec.lstrip().startswith("-")
            and not any(c in spec for c in "/\\@") and "\n" not in spec)


def missing(specs) -> list[str]:
    return [s for s in specs or () if not valid(s) or not _satisfied(s)]


def install(specs, timeout: int = 600) -> dict:
    """Install ``specs`` into the running interpreter. Returns ok/command/output."""
    specs = list(specs or ())
    bad = [s for s in specs if not valid(s)]
    if bad:
        raise ValueError("invalid package requirement: " + ", ".join(map(str, bad)))
    if not specs:
        return {"ok": True, "command": [], "output": ""}
    uv = shutil.which("uv")
    cmd = ([uv, "pip", "install", "--python", sys.executable] if uv
           else [sys.executable, "-m", "pip", "install"]) + specs
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout)
        ok, out = r.returncode == 0, (r.stdout or "") + (r.stderr or "")
    except (OSError, subprocess.TimeoutExpired) as e:
        ok, out = False, repr(e)
    importlib_invalidate()
    return {"ok": ok and not missing(specs), "command": cmd, "output": out[-4000:]}


def importlib_invalidate() -> None:
    import importlib
    importlib.invalidate_caches()
