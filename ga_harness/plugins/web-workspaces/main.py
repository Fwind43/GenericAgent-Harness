"""Web adapter; persistence and execution binding live in workspace-store."""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def apply(ctx, config):
    host, store = ctx.get("web.host"), ctx.get("workspaces")
    frontend = host.frontend

    def snapshot(data, nxt):
        data["scope"] = store.snapshot()
        return nxt(data)

    def read(_):
        with frontend.lock:
            return store.snapshot()

    def change(request):
        with frontend.lock:
            if frontend.running:
                return 409, {"error": "wait for the running task to finish"}
            try:
                store.sessions.save(frontend.messages)
                selected = store.change(request["body"])
                frontend.messages = selected["messages"]
                frontend.persistence_error = None
                data = frontend.snapshot()
            except ValueError as error:
                return 400, {"error": str(error)}
            except RuntimeError as error:
                return 409, {"error": str(error)}
            except Exception:
                return 503, {"error": "workspace storage unavailable; reload before retrying"}
            frontend._broadcast("snapshot", data)
            return data

    ctx.on("web.snapshot", snapshot)
    ctx.scope.add(host.register("web-workspaces", script=HERE / "client.js",
        style=HERE / "client.css", order=15,
        routes={("GET", ""): read, ("POST", ""): change}))
