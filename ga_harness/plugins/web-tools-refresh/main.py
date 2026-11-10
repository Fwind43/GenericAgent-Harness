"""web-tools-refresh: composer button that sends /tools (handled by the ga-tools-refresh plugin)."""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def apply(ctx, config):
    host = ctx.get("web.host")
    ctx.scope.add(host.register("web-tools-refresh", script=HERE / "client.js", style=HERE / "client.css", order=46))
