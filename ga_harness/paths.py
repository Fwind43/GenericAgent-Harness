"""Where ga-harness keeps its own data.

``home()`` is ``$GAH_HOME`` when set, else ``~/.ga-harness``. The desktop app sets
``GAH_HOME`` to a ``data`` folder next to the program (see desktop/src/backend.js), so an
installed or unpacked copy keeps its settings, plugins, uploads and chat history beside
itself; the CLI and the web launcher keep using ``~/.ga-harness``.

Chat history is per GenericAgent folder: ``session_db(ga_root)`` is
``<home>/sessions/<name>-<hash>/sessions.sqlite3``. The databases that hang off the
session store (channels, run queue, worldline) are siblings of that file, so they follow
the same split. The single pre-split ``<home>/sessions.sqlite3`` is claimed once by the
first GenericAgent folder that starts afterwards: it is copied (with its sibling
databases) and left in place, and later folders start empty.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
from pathlib import Path

SESSION_FILE = "sessions.sqlite3"
SESSION_SIBLINGS = ("channels.db", "run-queue.db", "worldline.db")
CLAIM_MARK = ".legacy-claimed"


def home() -> Path:
    return Path(os.environ.get("GAH_HOME") or Path.home() / ".ga-harness").expanduser()


def ga_key(ga_root: str) -> str:
    """Stable, readable folder name for a GenericAgent folder."""
    full = os.path.normcase(os.path.abspath(ga_root))
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", os.path.basename(full.rstrip("\\/")) or "ga")[:40]
    return f"{name}-{hashlib.sha1(full.encode('utf-8')).hexdigest()[:10]}"


def _copy_db(src: Path, dst: Path) -> None:
    for suffix in ("", "-wal", "-shm"):
        s = src.with_name(src.name + suffix)
        if s.is_file():
            shutil.copy2(s, dst.with_name(dst.name + suffix))


def _claim_legacy(base: Path, target: Path) -> None:
    legacy = base / SESSION_FILE
    root = base / "sessions"
    mark = root / CLAIM_MARK
    if not legacy.is_file() or mark.exists() or target.exists():
        return
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".claiming")
        _copy_db(legacy, tmp)
        for name in SESSION_SIBLINGS:
            if (base / name).is_file():
                _copy_db(base / name, target.with_name(name))
        for suffix in ("-wal", "-shm"):
            t = tmp.with_name(tmp.name + suffix)
            if t.is_file():
                os.replace(t, target.with_name(target.name + suffix))
        os.replace(tmp, target)
        mark.write_text(str(target.parent.name), encoding="utf-8")
    except OSError:
        pass  # fall back to an empty per-folder store; the legacy file is untouched


def session_db(ga_root: str | None) -> Path:
    base = home()
    if not ga_root:
        return base / SESSION_FILE
    target = base / "sessions" / ga_key(ga_root) / SESSION_FILE
    _claim_legacy(base, target)
    return target
