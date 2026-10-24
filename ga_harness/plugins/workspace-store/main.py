"""Workspace service, independent of CLI/TUI/Web presentation."""
from pathlib import Path
from ga_harness.workspaces import Workspaces


def apply(ctx, config):
    store = Workspaces(ctx.get("sessions"), config.get("workspace") or Path.cwd())
    if config.get("start_workspace"):
        store.change({"action": "workspace", "workspace": config["start_workspace"]})
    elif config.get("start_project"):
        store.change({"action": "select", "id": config["start_project"]})
    ctx.on("agent.request", store.request, priority=100)
    ctx.on("ga.agent_before", store.bind)
    ctx.on("ga.llm_before", store.inject)
    ctx.provide("workspaces", store)
