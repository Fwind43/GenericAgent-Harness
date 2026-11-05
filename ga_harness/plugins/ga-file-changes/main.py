"""ga-file-changes: which files did the agent change in this run?

Watches GA's ``file_write`` and ``file_patch`` tools through ``ga.tool_before`` /
``ga.tool_after``. A call counts only when GA reports success. When the run ends
(``ga.agent_after``) the worker emits one ``plugin.file_changes`` event through
``run.host``; its ``notes`` entry puts the list into the transcript and ``files``
carries the structured data ([{path, action, count, turns}]). The note's ``data``
holds a unified diff per file, from a snapshot taken before the run first touched
it to its content when the run ends (``max_diff_lines = 0`` turns this off).

Files changed indirectly (``code_run`` scripts, shell commands) are not seen.
Outside a worker (no ``run.host``) the plugin only keeps the list in memory.
"""
from __future__ import annotations

import difflib
import os
import threading

TOOLS = {"file_write", "file_patch"}
MAX_BYTES = 1 << 20  # larger files are listed without a diff
MAX_LINE = 2000  # longer diff lines are cut
MAX_TOTAL = 100_000  # diff characters per run, across all files
SNAP_TOTAL = 32 << 20  # snapshot bytes kept per run


def _read(path):
    """``(bytes, None)``; ``(None, None)`` when the file is absent; ``(None, reason)`` otherwise."""
    try:
        if not os.path.exists(path):
            return None, None
        if os.path.getsize(path) > MAX_BYTES:
            return None, "large"
        with open(path, "rb") as f:
            return f.read(), None
    except OSError:
        return None, "unreadable"


def _lines(data):
    """Text lines of ``data`` (``None`` = absent file, no lines), or ``None`` when it is not text."""
    if data is None:
        return []
    if b"\0" in data:
        return None
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return data.decode(encoding).splitlines()
        except UnicodeDecodeError:
            pass
    return None


def _diff(old, new, max_lines):
    """Unified diff hunks of two line lists -> ``(text, added, removed, truncated)``."""
    out, added, removed, total = [], 0, 0, 0
    for i, line in enumerate(difflib.unified_diff(old, new, lineterm="")):
        if i < 2:
            continue  # the ---/+++ file header
        total += 1
        if line.startswith("+"):
            added += 1
        elif line.startswith("-"):
            removed += 1
        if total <= max_lines:
            out.append(line if len(line) <= MAX_LINE else line[:MAX_LINE] + "\u2026")
    return "\n".join(out), added, removed, total > max_lines


def _abs_path(handler, path):
    if not isinstance(path, str) or not path:
        return ""
    getter = getattr(handler, "_get_abs_path", None)
    if callable(getter):
        try:
            return getter(path)
        except Exception:
            pass
    return os.path.abspath(os.path.join(getattr(handler, "cwd", None) or os.getcwd(), path))


def _succeeded(ret):
    data = getattr(ret, "data", None)
    return isinstance(data, dict) and data.get("status") == "success"


def _display(path, base):
    if base:
        try:
            rel = os.path.relpath(path, base)
            if not rel.startswith(".."):
                return rel.replace("\\", "/")
        except ValueError:  # different drive on Windows
            pass
    return path.replace("\\", "/")


def summarize(files, base=None, limit=50):
    """Plain-text transcript note: one ``+``/``~`` line per file, in first-change order."""
    lines = []
    for item in files[:limit]:
        mark = "+" if item["action"] == "created" else "~"
        extra = f" (x{item['count']})" if item["count"] > 1 else ""
        lines.append(f"{mark} {_display(item['path'], base)}{extra}")
    if len(files) > limit:
        lines.append(f"... +{len(files) - limit}")
    return "\n".join(lines)


def detail(files, snaps, base=None, limit=50, max_lines=400):
    """Note ``data`` for the web UI: one unified diff per file.

    ``snaps`` maps a path to ``_read``'s result from before the run first touched it; the
    diff runs from that snapshot to the current content. Files that cannot be diffed
    carry ``skipped`` (``binary`` / ``large`` / ``unreadable``)."""
    out, budget = [], MAX_TOTAL
    for item in files[:limit]:
        path = item["path"]
        entry = {"path": path, "display": _display(path, base), "action": item["action"],
                 "count": item["count"], "added": 0, "removed": 0, "diff": "",
                 "truncated": False}
        old, reason = snaps.get(path, (None, "unreadable"))
        new = old_lines = new_lines = None
        if not reason:
            new, reason = _read(path)
        if not reason:
            old_lines, new_lines = _lines(old), _lines(new)
            if old_lines is None or new_lines is None:
                reason = "binary"
        if reason:
            entry["skipped"] = reason
        else:
            text, added, removed, cut = _diff(old_lines, new_lines, max_lines)
            if len(text) > budget:
                text, cut = text[:max(0, text.rfind("\n", 0, budget))], True
            budget -= len(text)
            entry.update(added=added, removed=removed, diff=text, truncated=cut)
        out.append(entry)
    return {"base": base, "files": out, "more": max(0, len(files) - limit)}


def apply(ctx, config):
    host = ctx.get("run.host") if ctx.has("run.host") else None
    # Paths are shown relative to the session workspace; GA's own cwd is only a fallback.
    run_ctx = ctx.get("run.context") if ctx.has("run.context") else None
    workspace = run_ctx.get("workspace") if isinstance(run_ctx, dict) else None
    limit = max(1, int(config.get("max_files") or 50))
    try:
        max_lines = max(0, int(config.get("max_diff_lines", 400)))
    except (TypeError, ValueError):
        max_lines = 400
    def _int(key, default, low):
        try:
            return max(low, int(config.get(key, default)))
        except (TypeError, ValueError):
            return default
    max_height, collapse_after = _int("max_height", 420, 0), _int("collapse_after", 0, 0)
    lock = threading.Lock()
    state = {"files": {}, "pending": {}, "base": None, "snap": {}, "snap_bytes": 0}

    def snapshot(path):
        """Remember ``path`` as it was before the run first touched it."""
        data, reason = _read(path)
        with lock:
            if path in state["snap"]:
                return
            if data is not None:
                if state["snap_bytes"] + len(data) > SNAP_TOTAL:
                    data, reason = None, "large"
                else:
                    state["snap_bytes"] += len(data)
            state["snap"][path] = (data, reason)

    def before(gactx, nxt):
        if gactx.get("tool_name") in TOOLS:
            handler = gactx.get("self")
            args = gactx.get("args") or {}
            path = _abs_path(handler, args.get("path"))
            if path:
                existed = os.path.exists(path)
                with lock:
                    state["pending"][id(args)] = (path, existed)
                    fresh = max_lines > 0 and path not in state["snap"]
                if fresh:
                    snapshot(path)
        return nxt(gactx)

    def after(gactx, nxt):
        if gactx.get("tool_name") in TOOLS:
            args = gactx.get("args") or {}
            with lock:
                pending = state["pending"].pop(id(args), None)
            if pending and _succeeded(gactx.get("ret")):
                path, existed = pending
                handler = gactx.get("self")
                turn = getattr(handler, "current_turn", None)
                with lock:
                    item = state["files"].get(path)
                    if item is None:
                        item = state["files"][path] = {
                            "path": path, "action": "modified" if existed else "created",
                            "count": 0, "turns": []}
                    item["count"] += 1
                    if isinstance(turn, int) and turn not in item["turns"]:
                        item["turns"].append(turn)
        return nxt(gactx)

    def agent_before(gactx, nxt):
        handler = gactx.get("handler")
        with lock:
            state["files"], state["pending"] = {}, {}
            state["snap"], state["snap_bytes"] = {}, 0
            state["base"] = workspace or getattr(handler, "cwd", None)
        return nxt(gactx)

    def agent_after(gactx, nxt):
        with lock:
            files = list(state["files"].values())
            base, snaps = state["base"], state["snap"]
            state["snap"], state["snap_bytes"] = {}, 0
        if files and host is not None:
            note = {"kind": "files", "text": summarize(files, base, limit)}
            if max_lines > 0:
                try:
                    note["data"] = detail(files, snaps, base, limit, max_lines)
                    note["data"].update(max_height=max_height, collapse_after=collapse_after)
                except Exception:
                    pass
            data = {"files": files, "base": base, "notes": [note]}
            try:
                host.emit("file_changes", data)
            except Exception:
                pass
        return nxt(gactx)

    ctx.on("ga.agent_before", agent_before)
    ctx.on("ga.tool_before", before)
    ctx.on("ga.tool_after", after)
    ctx.on("ga.agent_after", agent_after)
    ctx.provide("ga.file_changes", lambda: [dict(item) for item in state["files"].values()])
