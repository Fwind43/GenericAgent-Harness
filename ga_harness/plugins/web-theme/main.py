"""web-theme: palettes + header theme picker for ui-web (browser-only, no API routes)."""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def apply(ctx, config):
    host = ctx.get("web.host")
    ctx.scope.add(host.register("web-theme", head=HERE / "head.js", style=HERE / "client.css",
                                script=HERE / "client.js", order=10))
