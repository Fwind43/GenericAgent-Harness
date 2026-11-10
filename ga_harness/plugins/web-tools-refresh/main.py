"""web-tools-refresh: "+" menu item that refreshes GA's tool definitions in a running task.

While a task is running, the item pushes ``tools.refresh`` to the run's worker,
where ga-tools-refresh clears ``last_tools`` so the next model call carries the
full tool definitions. No message is sent. Outside a run it is disabled: every
new run already starts with the full definitions.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def apply(ctx, config):
    host, runs = ctx.get("web.host"), ctx.get("runs")

    def refresh(request):
        body = request.get("body") or {}
        sid = body.get("session_id")
        if not isinstance(sid, str) or not sid:
            return 400, {"error": "session_id is required"}
        run = runs.active_for(sid)
        try:
            ok = bool(run) and runs.push(run["id"], "tools.refresh")
        except Exception:
            ok = False
        if not ok:
            return 409, {"error": "no running task"}
        return 200, {"ok": True}

    # Mount the worker side in every run, also in modes that do not include it.
    ctx.scope.add(runs.register_worker_plugin("ga-tools-refresh"))
    ctx.scope.add(host.register("web-tools-refresh", script=HERE / "client.js", style=HERE / "client.css", order=46,
                                routes={("POST", "refresh"): refresh}))
