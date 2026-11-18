"""Startup progress for a supervising process (the desktop shell).

When GAH_STARTUP_PROGRESS_FILE is set, every ``progress()`` call atomically rewrites it with
``{"pid", "seq", "stage", "detail", "ts"}``. The shell treats each change as proof that a slow
cold start (first-run .pyc compilation, antivirus scanning, many plugins) is still moving, and
shows the stage while it waits for GAH_WEB_READY_FILE. Without the variable this is a no-op,
and a failing write never affects startup.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

ENV = "GAH_STARTUP_PROGRESS_FILE"
_lock = threading.Lock()
_seq = 0


def progress(stage: str, detail: str = "") -> None:
    target = os.environ.get(ENV)
    if not target:
        return
    global _seq
    with _lock:
        _seq += 1
        data = {"pid": os.getpid(), "seq": _seq, "stage": stage, "detail": detail, "ts": time.time()}
        try:
            path = Path(target)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, path)
        except Exception:
            pass
