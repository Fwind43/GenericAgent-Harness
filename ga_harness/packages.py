"""Python package requirements declared by plugins (``packages = [...]``).

``missing`` checks the running interpreter; ``install`` installs into it with
uv when available, else pip. Nothing here runs automatically: installing is
an explicit user action from the plugin manager.
"""
from __future__ import annotations

import importlib.metadata as md
import logging
import os
import re
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path

log = logging.getLogger(__name__)

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
           else [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input"])
    if externally_managed():
        # The desktop build bundles a uv-managed standalone CPython that carries a PEP 668
        # EXTERNALLY-MANAGED marker; it is the app's private, writable runtime, so both uv
        # and pip must be told to override it or every plugin package install fails.
        cmd.append("--break-system-packages")
    cmd += specs
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PIP_DISABLE_PIP_VERSION_CHECK="1")
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout, env=env)
        rc, out = r.returncode, (r.stdout or "") + (r.stderr or "")
    except (OSError, subprocess.TimeoutExpired) as e:
        rc, out = None, repr(e)
    importlib_invalidate()
    ok = rc == 0 and not missing(specs)
    log.log(logging.INFO if ok else logging.WARNING, "package install rc=%s ok=%s cmd=%s\n%s",
            rc, ok, subprocess.list2cmdline(cmd), out[-1500:])
    return {"ok": ok, "command": cmd, "output": out[-4000:]}


def externally_managed() -> bool:
    """True when the running interpreter carries a PEP 668 EXTERNALLY-MANAGED marker
    (ignored inside a virtual environment, as PEP 668 specifies)."""
    if sys.prefix != sys.base_prefix:
        return False
    try:
        return (Path(sysconfig.get_path("stdlib")) / "EXTERNALLY-MANAGED").is_file()
    except (TypeError, OSError):
        return False


def importlib_invalidate() -> None:
    import importlib
    importlib.invalidate_caches()
