"""Channels service: platform-neutral hub plus the channel manager.

``channels`` is the hub (sessions binding, message routing). ``channel_manager``
owns channel instances: provider plugins (e.g. feishu) register a provider,
and channels are created, started, stopped and inspected through the manager
(web UI: the web-channels plugin).
"""
from pathlib import Path

from ga_harness.channel_manager import ChannelManager, ChannelStore
from ga_harness.channels import Bindings, Hub

HERE = Path(__file__).resolve().parent


def _store_path(sessions, name="channels.db"):
    base = getattr(sessions, "path", None) or getattr(sessions, "db_path", None)
    return Path(base).with_name(name) if base else HERE / name


def apply(ctx, config):
    runs, sessions = ctx.get("runs"), ctx.get("sessions")
    # model-store is optional ("models?") and may load, reload or stop later,
    # so the hub looks it up on each use instead of capturing it here.
    hub = Hub(runs, sessions, Bindings(_store_path(sessions)),
              workspace=(config or {}).get("workspace") or None,
              models=lambda: ctx.get("models"),
              workspaces=lambda: ctx.get("workspaces"))
    manager = ChannelManager(hub, ChannelStore(_store_path(sessions, "channels.json")))
    ctx.on("run.event", hub.on_run_event)
    ctx.on("run.finished", hub.on_run_finished)
    ctx.provide("channels", hub)
    ctx.provide("channel_manager", manager)

    def close():
        manager.close()
        hub.close()
    return close
