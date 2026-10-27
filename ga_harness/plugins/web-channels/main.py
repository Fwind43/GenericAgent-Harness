"""web-channels: channel management dialog for ui-web (backed by channel_manager).

GET  /api/p/web-channels/                      -> snapshot {providers, channels}
GET  /api/p/web-channels/?logs=<id>&after=<t>  -> {logs: [...]}
POST /api/p/web-channels/  {action: create|update|delete|start|stop|restart, ...}
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent
ACTIONS = ("start", "stop", "restart", "delete")


def _q(query, key, default=None):
    v = (query or {}).get(key, default)
    if isinstance(v, (list, tuple)):
        v = v[0] if v else default
    return v


def apply(ctx, config):
    host, manager = ctx.get("web.host"), ctx.get("channel_manager")

    def read(req):
        query = req.get("query") or {}
        cid = _q(query, "logs")
        if cid:
            try:
                after = float(_q(query, "after", 0) or 0)
                return {"logs": manager.get_logs(cid, after)}
            except KeyError:
                return 404, {"error": f"unknown channel: {cid}"}
            except ValueError:
                return 400, {"error": "invalid 'after'"}
        return manager.snapshot()

    def change(req):
        body = req.get("body") or {}
        action, cid = body.get("action"), body.get("id")
        try:
            if action == "create":
                manager.create(body)
            elif action == "update":
                manager.update(cid, body)
            elif action in ACTIONS:
                getattr(manager, action)(cid)
            else:
                return 400, {"error": f"unknown action: {action}"}
        except KeyError:
            return 404, {"error": f"unknown channel: {cid}"}
        except (ValueError, RuntimeError) as e:
            return 400, {"error": str(e)}
        return manager.snapshot()

    ctx.scope.add(host.register("web-channels", script=HERE / "client.js",
                                style=HERE / "client.css", order=35,
                                routes={("GET", ""): read, ("POST", ""): change}))
