from ga_harness.models import Models


def apply(ctx, config):
    ctx.provide("models", Models(ctx.get("ga.agent")))
