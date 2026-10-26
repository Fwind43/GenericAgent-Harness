"""Channels service: platform-neutral hub that chat adapters register with.

Other plugins obtain the hub with ``ctx.get("channels")`` and call
``hub.register(adapter)``; the returned disposer detaches it.
"""
from pathlib import Path

from ga_harness.channels import Bindings, Hub

HERE = Path(__file__).resolve().parent


def _store_path(sessions):
    base = getattr(sessions, "path", None) or getattr(sessions, "db_path", None)
    return Path(base).with_name("channels.db") if base else HERE / "channels.db"


def apply(ctx, config):
    runs, sessions = ctx.get("runs"), ctx.get("sessions")
    hub = Hub(runs, sessions, Bindings(_store_path(sessions)),
              workspace=(config or {}).get("workspace") or None)
    ctx.on("run.finished", hub.on_run_finished)
    ctx.provide("channels", hub)
    return hub.close
