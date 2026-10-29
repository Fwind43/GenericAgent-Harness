"""web-channels: channel management dialog for ui-web (backed by channel_manager).

GET  /api/p/web-channels/                      -> snapshot {providers, channels}
GET  /api/p/web-channels/?logs=<id>&after=<t>  -> {logs: [...]}
POST /api/p/web-channels/  {action: create|update|delete|start|stop|restart, ...}
POST /api/p/web-channels/  {action: pair_begin, provider|channel, id?, name?} -> {pairing}
POST /api/p/web-channels/  {action: pair_poll|pair_cancel, pairing}          -> {pairing}
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
        if action in ("pair_begin", "pair_poll", "pair_cancel"):
            try:
                if action == "pair_begin":
                    return {"pairing": manager.pair_begin(body)}
                return {"pairing": getattr(manager, action)(body.get("pairing") or "")}
            except KeyError as e:
                return 404, {"error": f"unknown pairing or channel: {e.args[0] if e.args else ''}"}
            except (ValueError, RuntimeError) as e:
                return 400, {"error": str(e)}
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
