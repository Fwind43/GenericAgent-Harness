"""Exclusive, process-lifetime ownership of a session database.

Only one host may run workers against a session database: a second host would mark the
first host's live runs ``interrupted`` while they keep running (ghost runs), and both
would contend for the SQLite write lock. The lock is an OS file lock, so a host that is
killed releases it automatically; nothing has to clean up a stale lock file.

Within one process the lock is shared (reference counted), so in-process re-opens such
as tests or plugin hot reloads keep working.
"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path

# The pid text lives at the start of the file; the locked byte sits past it, so that
# Windows' mandatory byte-range lock does not stop other processes reading the pid.
_LOCK_OFFSET = 1024

_held: dict[str, list] = {}   # path -> [file, refcount]
_guard = threading.Lock()


class OwnerLockError(RuntimeError):
    """Another process owns the session database."""


def _try_lock(fh) -> bool:
    if os.name == "nt":
        import msvcrt
        fh.seek(_LOCK_OFFSET)
        try:
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False
    import fcntl
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def _unlock(fh):
    try:
        if os.name == "nt":
            import msvcrt
            fh.seek(_LOCK_OFFSET)
            msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass


def _owner(path: Path) -> str:
    try:
        with open(path, "rb") as fh:
            return fh.read(64).split(b"\0", 1)[0].decode("ascii", "replace").strip()
    except OSError:
        return ""


class OwnerLock:
    def __init__(self, key: str):
        self.key = key
        self.released = False

    def release(self):
        with _guard:
            if self.released:
                return
            self.released = True
            entry = _held.get(self.key)
            if entry is None:
                return
            entry[1] -= 1
            if entry[1] <= 0:
                del _held[self.key]
                _unlock(entry[0])
                entry[0].close()


def acquire(db_path, wait: float = 15.0, interval: float = 0.2) -> OwnerLock:
    """Own ``db_path`` for this process; wait up to ``wait`` seconds for another owner.

    A previous host that is shutting down (stdin EOF -> cancel runs -> exit) normally
    lets go within its cancel grace, hence the wait. Raises :class:`OwnerLockError`.
    """
    path = Path(db_path).expanduser().resolve()
    lock_path = path.with_name(path.name + ".owner")
    key = str(lock_path).lower() if os.name == "nt" else str(lock_path)
    with _guard:
        entry = _held.get(key)
        if entry is not None:
            entry[1] += 1
            return OwnerLock(key)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # Not "a" mode: appends would ignore seek(0) when rewriting the pid.
    fh = open(os.open(lock_path, os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o644), "r+b")
    deadline = time.monotonic() + max(0.0, wait)
    try:
        while not _try_lock(fh):
            if time.monotonic() >= deadline:
                owner = _owner(lock_path)
                raise OwnerLockError(
                    f"session database {path} is in use by another GenericAgent-Harness "
                    f"process{f' (pid {owner})' if owner else ''}; stop it first")
            time.sleep(interval)
        fh.seek(0)
        fh.truncate()
        fh.write(f"{os.getpid()}\0".encode("ascii").ljust(64, b"\0"))
        fh.flush()
    except BaseException:
        fh.close()
        raise
    with _guard:
        entry = _held.get(key)
        if entry is not None:       # another thread of this process won the race
            entry[1] += 1
            _unlock(fh)
            fh.close()
        else:
            _held[key] = [fh, 1]
    return OwnerLock(key)
