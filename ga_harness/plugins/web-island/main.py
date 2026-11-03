"""web-island: floating task pill for the desktop shell (served page, no API routes).

The desktop app opens /web/web-island/island.html in a transparent always-on-top window;
the page follows /api/events like the main UI. Browsers never load it.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def apply(ctx, config):
    host = ctx.get("web.host")
    ctx.scope.add(host.register("web-island", files={
        "island.html": HERE / "island.html",
        "island.js": HERE / "island.js",
        "island.css": HERE / "island.css",
    }))
