"""plugin-control: the worker-side ``plugin_control`` tool.

Forwards list/enable/disable/rescan to the host's ``plugin_control`` RPC (answered
by run-store through plugin-manager). It is not part of every run: a mode (agent
preset) mounts it by listing it in ``plugins``, e.g. Creative mode.
"""
from __future__ import annotations

import importlib
import json

TIMEOUT = 60.0
TOOL = {"type": "function", "function": {
    "name": "plugin_control",
    "description": ("List, enable, disable or rescan ga-harness plugins. Changes apply immediately "
                    "in the host without a restart. Only user plugins in $GAH_HOME/plugins can "
                    "be toggled; after writing a new plugin there, call rescan, then enable it."),
    "parameters": {"type": "object", "properties": {
        "action": {"type": "string", "enum": ["list", "enable", "disable", "rescan"]},
        "name": {"type": "string", "description": "Plugin name, required for enable/disable"},
    }, "required": ["action"]},
}}


def apply(ctx, config):
    host = ctx.get("run.host") if ctx.has("run.host") else None
    if host is None:  # not inside an isolated run: there is no host to ask
        return None

    def plugin_control(handler, args, response):
        StepOutcome = importlib.import_module("agent_loop").StepOutcome
        args = args if isinstance(args, dict) else {}
        body = {"action": args.get("action", "list")}
        if args.get("name"):
            body["name"] = args["name"]
        try:
            msg = json.dumps(host.call("plugin_control", body, TIMEOUT), ensure_ascii=False, indent=1)
        except Exception as exc:  # RpcError and transport errors
            msg = f"[Error] plugin_control: {exc}"
        return StepOutcome(msg, next_prompt=msg + "\n")

    return ctx.get("ga.tools").register(TOOL, plugin_control)
