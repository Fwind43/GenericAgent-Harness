"""ga-file-changes: which files did the agent change in this run?

Watches GA's ``file_write`` and ``file_patch`` tools through ``ga.tool_before`` /
``ga.tool_after``. A call counts only when GA reports success. When the run ends
(``ga.agent_after``) the worker emits one ``plugin.file_changes`` event through
``run.host``; its ``notes`` entry puts the list into the transcript and ``files``
carries the structured data ([{path, action, count, turns}]).

Files changed indirectly (``code_run`` scripts, shell commands) are not seen.
Outside a worker (no ``run.host``) the plugin only keeps the list in memory.
"""
from __future__ import annotations

import os
import threading

TOOLS = {"file_write", "file_patch"}


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


def apply(ctx, config):
    host = ctx.get("run.host") if ctx.has("run.host") else None
    # Paths are shown relative to the session workspace; GA's own cwd is only a fallback.
    run_ctx = ctx.get("run.context") if ctx.has("run.context") else None
    workspace = run_ctx.get("workspace") if isinstance(run_ctx, dict) else None
    limit = max(1, int(config.get("max_files") or 50))
    lock = threading.Lock()
    state = {"files": {}, "pending": {}, "base": None}

    def before(gactx, nxt):
        if gactx.get("tool_name") in TOOLS:
            handler = gactx.get("self")
            args = gactx.get("args") or {}
            path = _abs_path(handler, args.get("path"))
            if path:
                with lock:
                    state["pending"][id(args)] = (path, os.path.exists(path))
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
            state["base"] = workspace or getattr(handler, "cwd", None)
        return nxt(gactx)

    def agent_after(gactx, nxt):
        with lock:
            files = list(state["files"].values())
            base = state["base"]
        if files and host is not None:
            data = {"files": files, "base": base,
                    "notes": [{"kind": "files", "text": summarize(files, base, limit)}]}
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
