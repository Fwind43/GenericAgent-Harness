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
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PIP_DISABLE_PIP_VERSION_CHECK="1")
    blocked = loaded_changes(cmd, specs, env)
    cmd += specs
    if blocked:
        # Replacing a package the running process has imported cannot work in place: on
        # Windows the loaded .pyd files are locked, so the installer uninstalls the old
        # version and then fails halfway, leaving a broken environment. Refuse instead.
        change = ", ".join(f"{n} {old} -> {new}" for n, old, new in blocked)
        manual = subprocess.list2cmdline(cmd)
        out = ("\u5b89\u88c5\u4f1a\u6539\u52a8\u5f53\u524d\u8fdb\u7a0b\u6b63\u5728\u4f7f\u7528\u7684\u5305\uff1a" + change
               + "\u3002\u8bf7\u9000\u51fa\u5e94\u7528\u540e\u624b\u52a8\u6267\u884c\uff1a" + manual + "\n"
               + "Installing would change packages already in use by this process: " + change
               + ". Quit the app and run manually: " + manual)
        log.warning("package install refused: %s", out)
        return {"ok": False, "command": cmd, "output": out, "blocked": [list(b) for b in blocked]}
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


_PLAN = re.compile(r"^\s*([+-])\s*([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)", re.M)
_PIP_PLAN = re.compile(r"^Would install (.+)$", re.M)


def _norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _plan(cmd, specs, env) -> dict[str, str] | None:
    """Dry-run ``cmd`` and return {normalized name: version to install}; None if unknown."""
    try:
        r = subprocess.run(cmd + ["--dry-run"] + specs, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=180, env=env)
    except (OSError, subprocess.TimeoutExpired):
        return None
    out = (r.stdout or "") + (r.stderr or "")
    if r.returncode != 0:
        return None
    plan = {_norm(n): v for sign, n, v in _PLAN.findall(out) if sign == "+"}
    for line in _PIP_PLAN.findall(out):
        for item in line.split():
            name, _, version = item.rpartition("-")
            if name:
                plan[_norm(name)] = version
    return plan


def _loaded_dists() -> dict[str, str]:
    """{normalized distribution name: installed version} for distributions with a
    top-level module currently imported in this process."""
    try:
        mapping = md.packages_distributions()
    except Exception:
        return {}
    loaded = {}
    for top, dists in mapping.items():
        if top in sys.modules:
            for d in dists:
                try:
                    loaded[_norm(d)] = md.version(d)
                except md.PackageNotFoundError:
                    pass
    return loaded


def loaded_changes(cmd, specs, env) -> list[tuple[str, str, str]]:
    """Imported distributions the install would replace: [(name, installed, planned)]."""
    plan = _plan(list(cmd), list(specs), env)
    if not plan:
        return []
    loaded = _loaded_dists()
    return sorted((n, loaded[n], v) for n, v in plan.items() if n in loaded and loaded[n] != v)


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
