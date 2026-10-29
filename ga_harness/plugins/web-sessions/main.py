"""web-sessions: Web session sidebar for ui-web: switch / new / rename / delete conversations (uses /api/sessions).

Sidebar preferences live in the session store so every client of the host (local or remote) shares them:
GET  /api/p/web-sessions/                      -> {prefs: {"sidebar.layout": ..., "sidebar.groups": ...}}
POST /api/p/web-sessions/  {key, value}        -> {prefs: ...}
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def apply(ctx, config):
    host = ctx.get("web.host")

    def store():
        return ctx.get("sessions")   # looked up per request: session-store may be disabled

    def read(req):
        sessions = store()
        if sessions is None:
            return 503, {"error": "session store unavailable"}
        return {"prefs": sessions.prefs()}

    def change(req):
        sessions, body = store(), req.get("body") or {}
        if sessions is None:
            return 503, {"error": "session store unavailable"}
        try:
            sessions.set_pref(body.get("key"), body.get("value"))
        except (TypeError, ValueError) as e:
            return 400, {"error": str(e)}
        return {"prefs": sessions.prefs()}

    ctx.scope.add(host.register("web-sessions", script=HERE / "client.js", style=HERE / "client.css", order=20,
                                routes={("GET", ""): read, ("POST", ""): change}))
