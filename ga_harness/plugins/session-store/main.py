import os
from ga_harness import paths
from ga_harness.sessions import Sessions


def apply(ctx, config):
    """Chat history lives per GenericAgent folder (see ga_harness.paths.session_db), so
    switching folders shows that folder's own conversations. An explicit ``file`` or
    $GAH_SESSION_DB still pins one database."""
    config = config or {}
    path = config.get("file") or os.environ.get("GAH_SESSION_DB")
    if not path:
        path = paths.session_db(config.get("ga_root") or os.environ.get("GA_ROOT"))
        path.parent.mkdir(parents=True, exist_ok=True)
    ctx.provide("sessions", Sessions(ctx.get("ga.agent"), path))
