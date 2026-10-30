"""Python package requirements declared by plugins (``packages = [...]``).

``missing`` checks the running interpreter; ``install`` installs into it with
uv when available, else pip. Nothing here runs automatically: installing is
an explicit user action from the plugin manager.

A plugin that declares ``isolated = true`` gets its own virtual environment at
``<home>/plugin-envs/<plugin>`` instead (``env=<plugin>``). Its packages are never
imported by the app process -- the plugin runs them in a child process started
with ``python_for(...)`` -- so they can pin versions that conflict with the app
(e.g. lark-oapi needs websockets<16 while GenericAgent pins websockets 17) and
installing them can never replace a file the running app has loaded.
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


def _satisfied(spec: str, version=md.version) -> bool:
    try:
        from packaging.requirements import Requirement
    except ImportError:
        Requirement = None
    if Requirement is None:
        m = _NAME.match(spec)
        if not m:
            return False
        try:
            version(m.group(1))
            return True
        except md.PackageNotFoundError:
            return False
    req = Requirement(spec)
    if req.marker is not None and not req.marker.evaluate():
        return True
    try:
        have = version(req.name)
    except md.PackageNotFoundError:
        return False
    return not req.specifier or req.specifier.contains(have, prereleases=True)


def valid(spec) -> bool:
    """A requirement string, never an installer option or a path/URL."""
    return (isinstance(spec, str) and bool(_NAME.match(spec)) and not spec.lstrip().startswith("-")
            and not any(c in spec for c in "/\\@") and "\n" not in spec)


_ENV_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def env_dir(env: str) -> Path:
    """Private virtual environment of plugin ``env``."""
    if not isinstance(env, str) or not _ENV_NAME.match(env):
        raise ValueError(f"invalid plugin environment name: {env!r}")
    from .paths import home
    return home() / "plugin-envs" / env


def env_python(env: str) -> Path:
    d = env_dir(env)
    return d / "Scripts" / "python.exe" if os.name == "nt" else d / "bin" / "python"


def _env_versions(env: str):
    """``md.version``-like lookup restricted to the plugin environment."""
    d = env_dir(env)
    sites = [d / "Lib" / "site-packages", *sorted(d.glob("lib/python*/site-packages"))]
    found = {}
    if env_python(env).is_file():
        for dist in md.distributions(path=[str(x) for x in sites if x.is_dir()]):
            name = dist.metadata["Name"] if dist.metadata else None
            if name:
                found.setdefault(_norm(name), dist.version)

    def lookup(name):
        try:
            return found[_norm(name)]
        except KeyError:
            raise md.PackageNotFoundError(name) from None
    return lookup


def missing(specs, env: str | None = None) -> list[str]:
    """Unmet requirements in the running interpreter, or in plugin ``env``."""
    version = _env_versions(env) if env else md.version
    return [s for s in specs or () if not valid(s) or not _satisfied(s, version)]


def isolated_env(manifest) -> str | None:
    return manifest.name if getattr(manifest, "isolated", False) else None


def missing_for(manifest) -> list[str]:
    """Unmet ``packages`` of a plugin manifest. An isolated plugin is also satisfied
    when the app interpreter already provides everything (e.g. an installed extra)."""
    specs = list(getattr(manifest, "packages", None) or ())
    env = isolated_env(manifest)
    lack = missing(specs, env=env)
    if lack and env and not missing(specs):
        return []
    return lack


def python_for(env: str, specs=()) -> str:
    """Interpreter a plugin's child process should use: its own environment when that
    satisfies ``specs``, else the running interpreter (packages installed alongside
    the app, e.g. as an extra)."""
    py = env_python(env)
    if py.is_file() and not missing(specs, env=env):
        return str(py)
    return sys.executable


def install_for(manifest, specs=None, timeout: int = 600) -> dict:
    specs = missing_for(manifest) if specs is None else specs
    return install(specs, timeout=timeout, env=isolated_env(manifest))


def _run(cmd, timeout, env):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout, env=env)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, repr(e)


def _install_env(env: str, specs: list[str], timeout: int) -> dict:
    """Create plugin ``env`` if needed and install ``specs`` into it. The app's own
    interpreter is never touched, so no in-use file can be replaced."""
    target, py = env_dir(env), env_python(env)
    uv = shutil.which("uv")
    run_env = dict(os.environ, PYTHONIOENCODING="utf-8", PIP_DISABLE_PIP_VERSION_CHECK="1")
    run_env.pop("VIRTUAL_ENV", None)
    out = ""
    if not py.is_file():
        if target.exists():
            shutil.rmtree(target)  # half-created environment we own
        target.parent.mkdir(parents=True, exist_ok=True)
        make = ([uv, "venv", "--python", sys.executable, str(target)] if uv
                else [sys.executable, "-m", "venv", str(target)])
        rc, out = _run(make, timeout, run_env)
        if rc != 0 or not py.is_file():
            log.warning("plugin env create failed rc=%s cmd=%s\n%s", rc,
                        subprocess.list2cmdline(make), out[-1500:])
            return {"ok": False, "command": make, "output": out[-4000:]}
    cmd = ([uv, "pip", "install", "--python", str(py)] if uv
           else [str(py), "-m", "pip", "install", "--disable-pip-version-check", "--no-input"])
    cmd += specs
    rc, more = _run(cmd, timeout, run_env)
    out += more
    ok = rc == 0 and not missing(specs, env=env)
    log.log(logging.INFO if ok else logging.WARNING, "plugin env %s install rc=%s ok=%s cmd=%s\n%s",
            env, rc, ok, subprocess.list2cmdline(cmd), out[-1500:])
    return {"ok": ok, "command": cmd, "output": out[-4000:], "env": str(target)}


def install(specs, timeout: int = 600, env: str | None = None) -> dict:
    """Install ``specs`` into the running interpreter, or into plugin ``env``.
    Returns ok/command/output."""
    specs = list(specs or ())
    bad = [s for s in specs if not valid(s)]
    if bad:
        raise ValueError("invalid package requirement: " + ", ".join(map(str, bad)))
    if not specs:
        return {"ok": True, "command": [], "output": ""}
    if env:
        return _install_env(env, specs, timeout)
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
