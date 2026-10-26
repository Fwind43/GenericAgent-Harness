"""Frontend-neutral isolated execution service."""
from ga_harness.runs import Runs
from ga_harness.worker import recipe_for


def apply(ctx, config):
    store = ctx.get("sessions")
    service = Runs(store, ctx.get("workspaces"),
                   lambda: recipe_for(ctx, config.get("worker_plugins", ())),
                   emit=ctx.emit, max_parallel=config.get("max_parallel", 4),
                   cancel_grace=config.get("cancel_grace", 5))
    store.parallel = True
    ctx.provide("runs", service)

    def dispose():
        service.close()
        store.parallel = False

    return dispose
