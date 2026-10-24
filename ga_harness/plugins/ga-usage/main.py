"""ga-usage: token usage per LLM call and per run, as structured events.

GA records usage in ``llmcore._record_usage(usage, api_mode)`` (called by its global name)
and keeps the last call in ``llmcore.STATS``; it only *prints* the numbers. This plugin
wraps ``_record_usage`` in place (restored on unmount) to see the raw usage dict, and
reads ``STATS['out']`` after the call, because the streaming ``messages`` protocol sets
the output count later than ``_record_usage``.

Counting follows GA: ``input`` includes cached tokens (messages: input + creation + read).

Events:
    usage        {turn, input, cache_read, cache_write, output}   after each LLM call
    usage.total  {calls, input, cache_read, cache_write, output}  at agent_after
                 (before GA queues its final ``done``, so frontends get it first)
"""
from __future__ import annotations
import sys

FIELDS = ("input", "cache_read", "cache_write", "output")


def _i(v) -> int:
    try:
        return 0 if v is None else int(v)
    except (TypeError, ValueError):
        return 0


def parse(usage, api_mode) -> dict | None:
    """Raw provider usage -> {input, cache_read, cache_write, output}; None if unknown."""
    if not isinstance(usage, dict) or not usage:
        return None
    if api_mode == "responses":
        return {"input": _i(usage.get("input_tokens")),
                "cache_read": _i((usage.get("input_tokens_details") or {}).get("cached_tokens")),
                "cache_write": 0, "output": _i(usage.get("output_tokens"))}
    if api_mode == "chat_completions":
        return {"input": _i(usage.get("prompt_tokens")),
                "cache_read": _i((usage.get("prompt_tokens_details") or {}).get("cached_tokens")),
                "cache_write": 0, "output": _i(usage.get("completion_tokens"))}
    if api_mode == "messages":
        cw, cr = _i(usage.get("cache_creation_input_tokens")), _i(usage.get("cache_read_input_tokens"))
        return {"input": _i(usage.get("input_tokens")) + cw + cr, "cache_read": cr,
                "cache_write": cw, "output": _i(usage.get("output_tokens"))}
    return None


def apply(ctx, config):
    state = {"mod": None, "orig": None, "wrap": None, "last": None}
    total = {"calls": 0, **{k: 0 for k in FIELDS}}

    def install():
        mod = sys.modules.get("llmcore")
        if mod is None or state["mod"] is mod:
            return
        orig = getattr(mod, "_record_usage", None)
        if not callable(orig):
            return

        def wrapped(usage, api_mode, *a, **kw):
            try:
                rec = parse(usage, api_mode)
                if rec is not None:
                    state["last"] = rec
            except Exception:
                pass
            return orig(usage, api_mode, *a, **kw)
        wrapped.__wrapped__ = orig
        mod._record_usage = wrapped
        state.update(mod=mod, orig=orig, wrap=wrapped)

    def uninstall():
        mod = state["mod"]
        if mod is not None and getattr(mod, "_record_usage", None) is state["wrap"]:
            mod._record_usage = state["orig"]
        state.update(mod=None, orig=None, wrap=None)

    def reset():
        total.update(calls=0, **{k: 0 for k in FIELDS})

    def on_agent_before(g, nxt):
        install()
        reset()
        return nxt(g)

    def on_llm_before(g, nxt):
        install()
        state["last"] = None
        return nxt(g)

    def on_llm_after(g, nxt):
        rec, state["last"] = state["last"], None
        if rec is not None:
            stats = getattr(state["mod"], "STATS", None)
            out = stats.get("out") if isinstance(stats, dict) else None
            if _i(out) > rec["output"]:
                rec["output"] = _i(out)
            total["calls"] += 1
            for k in FIELDS:
                total[k] += rec[k]
            ctx.emit("usage", {"turn": g.get("turn"), **rec})
        return nxt(g)

    def on_agent_after(g, nxt):
        if total["calls"]:
            ctx.emit("usage.total", dict(total))
        return nxt(g)

    for ev, fn in (("agent_before", on_agent_before), ("llm_before", on_llm_before),
                   ("llm_after", on_llm_after), ("agent_after", on_agent_after)):
        ctx.on("ga." + ev, fn)
    ctx.scope.add(uninstall)
