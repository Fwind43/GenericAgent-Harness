"""ga-hooks: subscribe to GA's own hook registry without touching GA source.

GA calls ``plugins.hooks.trigger(event, locals())`` at 8 points in agent_loop.
For each event we register one callback that runs the harness waterfall
``ga.<event>`` with the GA ctx dict; listeners use ``fn(gactx, next)`` and may
return a replacement dict (GA adopts any dict returned by a hook).
Unloading the plugin unregisters every callback.
"""
from __future__ import annotations
import importlib
import sys

EVENTS = ("agent_before", "agent_after", "turn_before", "turn_after",
          "llm_before", "llm_after", "tool_before", "tool_after")


def load_hooks_module(ga_root: str | None):
    if ga_root and ga_root not in sys.path:
        sys.path.insert(0, ga_root)
    # must be the same module object agent_loop imported as `plugins.hooks`
    return importlib.import_module("plugins.hooks")


def apply(ctx, config):
    hooks = load_hooks_module(config.get("ga_root"))
    events = config.get("events") or EVENTS

    def make(event):
        name = "ga." + event

        def cb(gactx):
            out = ctx.waterfall(name, gactx)
            return out if isinstance(out, dict) else None
        return cb

    for ev in events:
        cb = make(ev)
        hooks.register(ev)(cb)
        ctx.scope.add(lambda ev=ev, cb=cb: hooks.unregister(ev, cb))
    ctx.provide("ga.hooks", hooks)
