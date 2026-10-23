"""tool-timer: time each GA tool call without touching GA.

GA passes dispatch()'s locals() to both tool_before and tool_after; the ``args``
dict is the same object in both, so its id() pairs the two events.

config:
  print   write "[tool-timer] name 0.123s" to stderr after each call (default: true)
  ignore  tool names not timed (default: ["no_tool"], GA's pseudo-tool for plain replies)
"""
from __future__ import annotations
import sys
import time


class ToolTimer:
    def __init__(self):
        self.calls: list[dict] = []

    def stats(self) -> dict:
        out: dict[str, dict] = {}
        for c in self.calls:
            s = out.setdefault(c["tool"], {"count": 0, "total": 0.0, "max": 0.0})
            s["count"] += 1
            s["total"] += c["seconds"]
            s["max"] = max(s["max"], c["seconds"])
        return out


def apply(ctx, config):
    timer = ToolTimer()
    pending: dict[int, float] = {}
    echo = config.get("print", True)
    ignore = set(config.get("ignore", ["no_tool"]))

    def before(gactx, nxt):
        args = gactx.get("args")
        if args is not None and gactx.get("tool_name") not in ignore:
            pending[id(args)] = time.perf_counter()
        return nxt(gactx)

    def after(gactx, nxt):
        args = gactx.get("args")
        t0 = pending.pop(id(args), None) if args is not None else None
        if t0 is not None:
            rec = {"tool": gactx.get("tool_name", "?"),
                   "index": (args or {}).get("_index", 0),
                   "seconds": time.perf_counter() - t0}
            timer.calls.append(rec)
            ctx.emit("tool.timed", rec)
            if echo:
                print(f"[tool-timer] {rec['tool']} {rec['seconds']:.3f}s", file=sys.stderr, flush=True)
        return nxt(gactx)

    ctx.on("ga.tool_before", before)
    ctx.on("ga.tool_after", after)
    ctx.provide("tool.timer", timer)
