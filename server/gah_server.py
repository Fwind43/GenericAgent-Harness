"""Headless launcher for the ga-harness server package (no desktop shell).

Package layout (built by server/build.sh from desktop/stage):
  python/        standalone CPython with ga_harness's and GenericAgent's dependencies
  py/            the ga_harness package (+ built web UI) and py/genericagent (pinned GA source)
  gah-server     shell entry point that runs this file with the bundled interpreter

GenericAgent writes its state next to its code (mykey.py, memory/, temp/), so, like the
desktop app (desktop/src/backend.js syncBundledGa), the shipped GA is copied to a writable
directory, $GAH_HOME/genericagent by default. When the shipped commit changes, code files are
overwritten while mykey.py, temp/ and existing memory/ files are kept.

Environment (all optional):
  GAH_HOME             data directory (default ~/.ga-harness)
  GA_ROOT              use this GenericAgent checkout instead of the bundled copy
  GAH_WEB_HOST         bind address (default 127.0.0.1; 0.0.0.0 to listen on all interfaces)
  GAH_WEB_PORT         port (default 8765)
  GAH_WEB_TOKEN        access token; if unset, generated once for ALL bind addresses
                       (including loopback) and kept in $GAH_HOME/web-token
  GAH_WEB_ALLOW_NO_TOKEN  explicitly opt out of automatic token generation (1/true/yes)
  GAH_WEB_ALLOWED_ORIGINS  see ga_harness/plugins/ui-web/main.py
Extra arguments are passed to `ga_harness.cli run` (e.g. --profile, --patch).
"""
import os
import secrets
import shutil
import sys
from pathlib import Path

APP = Path(__file__).resolve().parent
PY = APP / "py"
GA_REF_FILE = ".gah-ga-ref"
EMPTY_MYKEY = ("# GenericAgent model configuration.\n"
               "# Add models in GenericAgent-Harness: Settings > Models (they are written to this file).\n")


def _ref(d):
    try:
        return (Path(d) / GA_REF_FILE).read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def _is_ga_root(d):
    return (Path(d) / "agentmain.py").is_file()


def _copy_tree(src, dest):
    for root, _dirs, names in os.walk(src):
        rel = Path(root).relative_to(src)
        (dest / rel).mkdir(parents=True, exist_ok=True)
        for name in names:
            r = rel / name
            if r.as_posix() in (GA_REF_FILE, "mykey.py") or r.parts[0] == "temp":
                continue
            out = dest / r
            if r.parts[0] == "memory" and out.exists():
                continue
            if os.path.islink(src / r) or not (src / r).is_file():
                continue
            shutil.copyfile(src / r, out)


def sync_ga(dest):
    src = PY / "genericagent"
    if not _is_ga_root(src):
        sys.exit(f"gah-server: bundled GenericAgent missing at {src}")
    ref = _ref(src)
    if not (ref and _ref(dest) == ref and _is_ga_root(dest)):
        print(f"gah-server: installing GenericAgent {ref or 'unknown'} -> {dest}", flush=True)
        dest.mkdir(parents=True, exist_ok=True)
        _copy_tree(src, dest)
        # Written last: an interrupted copy is retried on the next start.
        (dest / GA_REF_FILE).write_text(f"{ref or 'unknown'}\n", encoding="utf-8")
    mykey = dest / "mykey.py"
    if not mykey.exists():
        mykey.write_text(EMPTY_MYKEY, encoding="utf-8")
    return dest


def main():
    env = os.environ
    home = Path(env.get("GAH_HOME") or Path.home() / ".ga-harness").expanduser()
    home.mkdir(parents=True, exist_ok=True)
    env["GAH_HOME"] = str(home)
    ga_root = env.get("GA_ROOT") or str(sync_ga(home / "genericagent"))
    host = env.setdefault("GAH_WEB_HOST", "127.0.0.1")
    port = env.setdefault("GAH_WEB_PORT", "8765")
    env.setdefault("GAH_WEB_OPEN_BROWSER", "0")
    flag = (env.get("GAH_WEB_ALLOW_NO_TOKEN") or "").strip().lower()
    allow_no_token = flag in ("1", "true", "yes")
    env["GAH_WEB_ALLOW_NO_TOKEN"] = "1" if allow_no_token else "0"
    if not env.get("GAH_WEB_TOKEN") and not allow_no_token:
        tok_file = home / "web-token"
        tok = tok_file.read_text(encoding="utf-8").strip() if tok_file.exists() else ""
        if not tok:
            tok = secrets.token_urlsafe(24)
            tok_file.write_text(tok + "\n", encoding="utf-8")
            try:
                tok_file.chmod(0o600)
            except OSError:
                pass
        env["GAH_WEB_TOKEN"] = tok
    if env.get("GAH_WEB_TOKEN"):
        shown = "<server-ip>" if host in ("0.0.0.0", "::", "") else host
        print(f"gah-server: open http://{shown}:{port}/?gah_token=<token>  "
              f"(token in GAH_WEB_TOKEN or {home / 'web-token'})", flush=True)
    else:
        print("gah-server: WARNING: automatic token authentication disabled; "
              "do not expose without external authentication", file=sys.stderr, flush=True)
        print(f"gah-server: open http://{host}:{port}/", flush=True)
    env["PYTHONPATH"] = str(PY) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    env.setdefault("PYTHONUNBUFFERED", "1")
    os.chdir(PY)
    argv = [sys.executable, "-m", "ga_harness.cli", "run", "--ui", "web", "--ga-root", ga_root, *sys.argv[1:]]
    os.execve(sys.executable, argv, env)


if __name__ == "__main__":
    main()
