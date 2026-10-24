import os
from ga_harness.sessions import Sessions

def apply(ctx, config):
    path = (config or {}).get("file") or os.environ.get("GAH_SESSION_DB") or "~/.ga-harness/sessions.sqlite3"
    ctx.provide("sessions", Sessions(ctx.get("ga.agent"), path))
