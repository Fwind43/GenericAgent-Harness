"""web-mermaid: render ```mermaid blocks in ui-web messages. Browser-only; the bundled
mermaid.min.js (MIT, see mermaid.LICENSE) is served as a lazily loaded file asset."""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def apply(ctx, config):
    host = ctx.get("web.host")
    ctx.scope.add(host.register("web-mermaid", script=HERE / "client.js", style=HERE / "client.css",
                                files={"mermaid.min.js": HERE / "mermaid.min.js"}, order=60))
