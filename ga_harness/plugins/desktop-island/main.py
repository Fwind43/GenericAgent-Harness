"""desktop-island: floating task pill for the desktop shell (served page, no API routes).

It declares a desktop overlay window through ``web.host.register(desktop=...)``; the desktop
app opens /web/desktop-island/island.html in a transparent always-on-top window and closes it
when this plugin is disabled. The page follows /api/events like the main UI. Browsers never load it.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def apply(ctx, config):
    host = ctx.get("web.host")
    ctx.scope.add(host.register("desktop-island", files={
        "island.html": HERE / "island.html",
        "island.js": HERE / "island.js",
        "island.css": HERE / "island.css",
    }, desktop=[{
        "id": "island", "page": "island.html", "kind": "overlay", "anchor": "top",
        "title": "GA Island", "width": 240, "height": 48,
        "data": {"pinned": bool(config.get("pinned", False))},
    }]))
