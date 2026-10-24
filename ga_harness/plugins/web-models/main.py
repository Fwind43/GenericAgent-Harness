"""web-models: Web model picker and model config dialog for ui-web (uses /api/models/*)."""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def apply(ctx, config):
    host = ctx.get("web.host")
    ctx.scope.add(host.register("web-models", script=HERE / "client.js", style=HERE / "client.css", order=30))
