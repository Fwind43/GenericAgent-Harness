"""web-sessions: Web session bar for ui-web: switch / new / rename / delete conversations (uses /api/sessions)."""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def apply(ctx, config):
    host = ctx.get("web.host")
    ctx.scope.add(host.register("web-sessions", script=HERE / "client.js", order=20))
