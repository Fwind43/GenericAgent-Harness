"""Frontend-neutral isolated execution service."""
from ga_harness.runs import Runs
from ga_harness.worker import recipe_for


def _plugin_control(ctx, body):
    # Resolved lazily: plugin.manager is optional and may mount after run-store.
    if not ctx.has("plugin.manager"):
        raise RuntimeError("plugin-manager is not enabled")
    return ctx.get("plugin.manager").agent_control(body)


def apply(ctx, config):
    store = ctx.get("sessions")
    service = Runs(store, ctx.get("workspaces"),
                   lambda: recipe_for(ctx, set(config.get("worker_plugins", ())) | service.extra_worker_plugins()),
                   emit=ctx.emit, max_parallel=config.get("max_parallel", 4),
                   cancel_grace=config.get("cancel_grace", 5),
                   plugin_handler=lambda body: _plugin_control(ctx, body))
    store.parallel = True
    ctx.provide("runs", service)

    def dispose():
        service.close()
        store.parallel = False

    return dispose
