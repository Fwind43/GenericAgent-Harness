"""web-trace: Trace view for ui-web (timeline of inputs, model calls, tool calls and timings)."""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def apply(ctx, config):
    host = ctx.get("web.host")
    ctx.scope.add(host.register("web-trace", script=HERE / "client.js", style=HERE / "client.css", order=45))
