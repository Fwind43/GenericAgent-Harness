"""Workspace service, independent of CLI/TUI/Web presentation."""
from pathlib import Path
from ga_harness.workspaces import Workspaces


def ga_temp(hooks):
    """GA's own working directory (<GA>/temp), the official default cwd."""
    try:
        root = Path(hooks.__file__).resolve().parents[1]
    except Exception:
        return None
    temp = root / "temp"
    return temp if temp.is_dir() else None


def apply(ctx, config):
    temp = ga_temp(ctx.get("ga.hooks"))
    store = Workspaces(ctx.get("sessions"), config.get("workspace") or temp or Path.cwd(),
                       projects_root=temp / "projects" if temp else None)
    if config.get("start_workspace"):
        store.change({"action": "workspace", "workspace": config["start_workspace"]})
    elif config.get("start_project"):
        store.change({"action": "select", "id": config["start_project"]})
    ctx.on("agent.request", store.request, priority=100)
    ctx.on("ga.agent_before", store.bind)
    ctx.on("ga.llm_before", store.inject)
    ctx.provide("workspaces", store)
