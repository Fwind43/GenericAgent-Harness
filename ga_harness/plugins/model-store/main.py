from ga_harness.models import Models


def apply(ctx, config):
    info = ctx.get("llm.config") or {}
    ctx.provide("models", Models(ctx.get("ga.agent"), info.get("source"), info.get("fallback")))
