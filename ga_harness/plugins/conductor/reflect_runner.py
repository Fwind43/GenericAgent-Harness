"""Isolated reflect script process. Only the supervisor reads/writes the IPC directory.

Script stdout/stderr are discarded by the caller; they cannot corrupt the protocol.
There is deliberately no model/session access here. This is isolation, NOT a sandbox.
"""
from __future__ import annotations

import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time
import traceback

MAX_TEXT = 20_000


def main():
    directory, path = Path(sys.argv[1]), Path(sys.argv[2])
    sys.path.insert(0, str(path.parent))
    os.chdir(path.parent)
    module, stamp, args = None, None, []
    seen = 0

    def load():
        nonlocal module, stamp
        current = (path.stat().st_mtime_ns, path.stat().st_size)
        if module is not None and current == stamp:
            return
        spec = importlib.util.spec_from_file_location("reflect_script", path)
        candidate = importlib.util.module_from_spec(spec)
        # Compile from source rather than a timestamp-based .pyc (same-second edits).
        sys.modules["reflect_script"] = candidate
        exec(compile(path.read_bytes(), str(path), "exec"), candidate.__dict__)
        if not callable(getattr(candidate, "check", None)):
            raise ValueError("script must define check()")
        if callable(getattr(candidate, "init", None)):
            candidate.init(args)
        module, stamp = candidate, current

    while True:
        request = directory / "request.json"
        if not request.exists():
            time.sleep(0.1)
            continue
        body = json.loads(request.read_text(encoding="utf-8"))
        if body["seq"] == seen:
            time.sleep(0.1)
            continue
        seen = body["seq"]
        try:
            op = body["op"]
            value = None
            if op == "init":
                args = body.get("args", [])
                load()
            elif op == "check":
                load()  # Reload only between turns; on_done uses the triggering module.
                value = module.check()
                if value is not None and not isinstance(value, str):
                    raise ValueError("check() must return text, an empty string/None, or '/exit'")
                if value and len(value) > MAX_TEXT:
                    raise ValueError(f"check() text exceeds {MAX_TEXT} characters")
            elif op == "done":
                callback = getattr(module, "on_done", None)
                if callable(callback):
                    callback(body.get("result", ""))
            else:
                raise ValueError("unknown reflect command")
            interval = float(getattr(module, "INTERVAL", 5))
            if not math.isfinite(interval):
                raise ValueError("INTERVAL must be finite")
            reply = {"seq": seen, "value": value, "interval": max(1, min(interval, 86400)),
                     "once": bool(getattr(module, "ONCE", False))}
        except BaseException:
            reply = {"seq": seen, "error": traceback.format_exc()[-4000:]}
        tmp = directory / "response.tmp"
        tmp.write_text(json.dumps(reply, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, directory / "response.json")
        if "error" in reply:
            return


if __name__ == "__main__":
    main()
