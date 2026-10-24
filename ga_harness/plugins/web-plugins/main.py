"""web-plugins: Web plugin manager dialog for ui-web (uses /api/plugins); changes apply on next start."""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def apply(ctx, config):
    host = ctx.get("web.host")
    ctx.scope.add(host.register("web-plugins", script=HERE / "client.js", style=HERE / "client.css", order=40))
