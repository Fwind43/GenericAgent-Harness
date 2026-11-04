import os
from ga_harness import ownerlock, paths
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
    # One host per database: a second host would mark the first host's live runs
    # interrupted while their workers keep running. Waits briefly for a host that is
    # still shutting down; the OS drops the lock when a host is killed.
    lock = ownerlock.acquire(path, wait=float(config.get("owner_wait", 15)))
    try:
        ctx.provide("sessions", Sessions(ctx.get("ga.agent"), path))
    except BaseException:
        lock.release()
        raise
    return lock.release
