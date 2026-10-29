"""Find GenericAgent and run `gah run` under GA's own interpreter.

GA's dependencies live in its checkout's .venv, not in the harness venv.  When
`gah run` starts under some other Python, it re-executes itself with GA's
interpreter (PYTHONPATH -> this repo) so users never set paths by hand.

ga_root resolution order: --ga-root > $GA_ROOT > $GAH_HOME/config.toml `ga_root` ($GAH_HOME defaults to ~/.ga-harness).
"""
from __future__ import annotations
import os
import subprocess
import sys
import tomllib
from pathlib import Path
from . import paths

REPO = Path(__file__).resolve().parent.parent
REEXEC_ENV = "GAH_REEXEC"


def config_path() -> Path:
    return paths.home() / "config.toml"


def resolve_ga_root(cli_value: str | None = None) -> str | None:
    if cli_value:
        return str(Path(cli_value).resolve())
    if os.environ.get("GA_ROOT"):
        return str(Path(os.environ["GA_ROOT"]).resolve())
    p = config_path()
    if p.is_file():
        v = tomllib.loads(p.read_text(encoding="utf-8")).get("ga_root")
        if v:
            return str(Path(v).expanduser().resolve())
    return None


def ga_python(ga_root: str | None) -> Path | None:
    if not ga_root:
        return None
    for rel in (".venv/Scripts/python.exe", ".venv/bin/python"):
        p = Path(ga_root) / rel
        if p.is_file():
            return p
    return None


def _same(a: Path, b: str) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def reexec_command(argv: list[str], ga_root: str | None):
    """Return (cmd, env) to re-run under GA's python, or None to run in-process."""
    if os.environ.get(REEXEC_ENV):
        return None
    py = ga_python(ga_root)
    if py is None:
        return None
    venv = py.parent.parent
    if _same(py, sys.executable) or _same(venv, sys.prefix):
        return None
    env = dict(os.environ)
    env[REEXEC_ENV] = "1"
    env["GA_ROOT"] = ga_root
    env["PYTHONPATH"] = os.pathsep.join([str(REPO)] + [p for p in env.get("PYTHONPATH", "").split(os.pathsep) if p])
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return [str(py), "-m", "ga_harness.cli", *argv], env


def maybe_reexec(argv: list[str], ga_root: str | None) -> int | None:
    plan = reexec_command(argv, ga_root)
    if plan is None:
        return None
    cmd, env = plan
    # The child shares our console, so Ctrl+C reaches it directly (ui-tui turns it into an
    # abort). subprocess.call would kill the child on KeyboardInterrupt; instead keep waiting
    # and let the child decide whether to exit.
    proc = subprocess.Popen(cmd, env=env)
    while True:
        try:
            return proc.wait()
        except KeyboardInterrupt:
            continue
