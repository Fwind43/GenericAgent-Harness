"""conductor-worker: the worker half of conductor mode (modelled on GA Admin).

The host plugin ``conductor`` owns tasks, limits and child sessions and answers
the ``conductor`` RPC. This worker plugin asks the host for the run's role at the
start of the task (RPC replies are only delivered once the run's control thread
is up, so the call cannot happen in ``apply``):

* ``parent``  -- register the ``conductor_*`` tools, hide every other tool except
  ``ask_user`` / ``update_working_checkpoint`` / ``no_tool``, and add the
  conductor rules to the system prompt.
* ``worker``  -- a delegated child task: add a short brief so it reports a
  verifiable result; tools are unchanged.
* otherwise   -- do nothing.
"""
from __future__ import annotations

import importlib
import json

KEEP = ("ask_user", "update_working_checkpoint", "no_tool")
RPC_TIMEOUT = 150.0  # collect may wait up to 120 s on the host

PARENT_PROMPT = """
### Conductor mode
You are the conductor of this session. You do not do the work yourself: you plan,
delegate to child tasks, review their results and decide.
- Split the request into independent, verifiable tasks; dispatch each with
  `conductor_dispatch` (a complete, self-contained objective: context, scope,
  deliverable, how to verify). Children cannot see this conversation.
- At most 3 tasks run at once, 12 may be unresolved, 48 per session.
- When tasks are running, call `conductor_collect` (optionally waiting) instead of
  polling; you are also woken automatically when a child finishes.
- Use `conductor_inspect` for details, `conductor_instruct` to steer or continue a
  task, `conductor_cancel` to stop one.
- Every finished task must be reviewed with `conductor_review`: `verified` only
  with concrete evidence in `basis`, otherwise `needs_work` and instruct again.
  Then close it with `conductor_resolve`.
- Report to the user only verified results; state clearly what is unverified.
"""

WORKER_PROMPT = """
### Delegated task
This session runs a task delegated by a conductor. Work only on the objective you
were given. Finish with a concise report: what was done, the concrete evidence
(files, commands, outputs) and anything left unverified or blocked.
"""


def _tool(name, description, properties=None, required=()):
    return {"type": "function", "function": {
        "name": name, "description": description,
        "parameters": {"type": "object", "properties": properties or {},
                       "required": list(required)}}}


TASK_ID = {"task_id": {"type": "string", "description": "Task id returned by conductor_dispatch."}}

TOOLS = {
    "conductor_dispatch": (_tool(
        "conductor_dispatch",
        "Start a child task in its own session. The objective must be self-contained.",
        {"objective": {"type": "string", "description": "Complete task brief: context, scope, deliverable, verification."},
         "title": {"type": "string", "description": "Short title (optional)."}},
        ("objective",)), "dispatch"),
    "conductor_collect": (_tool(
        "conductor_collect",
        "Return finished tasks not yet collected. Optionally wait for one to finish.",
        {"wait_seconds": {"type": "number", "description": "Seconds to wait (0-120)."}}), "collect"),
    "conductor_tasks": (_tool("conductor_tasks", "List all tasks of this conductor session."), "tasks"),
    "conductor_inspect": (_tool(
        "conductor_inspect", "Show one task in detail, including its latest result.",
        TASK_ID, ("task_id",)), "inspect"),
    "conductor_instruct": (_tool(
        "conductor_instruct",
        "Send an instruction to a task: steers it if running, otherwise continues it.",
        {**TASK_ID, "instruction": {"type": "string"}}, ("task_id", "instruction")), "instruct"),
    "conductor_cancel": (_tool("conductor_cancel", "Cancel a running task.", TASK_ID, ("task_id",)), "cancel"),
    "conductor_review": (_tool(
        "conductor_review", "Record the review verdict of a finished task.",
        {**TASK_ID, "verdict": {"type": "string", "enum": ["verified", "needs_work"]},
         "basis": {"type": "string", "description": "Concrete evidence for the verdict (required)."}},
        ("task_id", "verdict", "basis")), "review"),
    "conductor_resolve": (_tool(
        "conductor_resolve", "Close a reviewed task.", TASK_ID, ("task_id",)), "resolve"),
}


def apply(ctx, config):
    host = ctx.get("run.host") if ctx.has("run.host") else None
    tools = ctx.get("ga.tools") if ctx.has("ga.tools") else None
    if host is None or tools is None:
        return  # not in a worker run
    state = {"role": None, "checked": False}

    def call(op, args):
        StepOutcome = importlib.import_module("agent_loop").StepOutcome
        body = {k: v for k, v in (args if isinstance(args, dict) else {}).items() if v is not None}
        body.update(op=op, session_id=host.session_id)
        try:
            msg = json.dumps(host.call("conductor", body, RPC_TIMEOUT), ensure_ascii=False, indent=1)
        except Exception as exc:  # RpcError and transport errors
            msg = f"[Error] conductor {op}: {exc}"
        return StepOutcome(msg, next_prompt=msg + "\n")

    def handler_for(op):
        def run(handler, args, response):
            return call(op, args)
        run.__name__ = "conductor_" + op
        return run

    def setup():
        state["checked"] = True
        try:
            info = host.call("conductor", {"op": "role", "session_id": host.session_id}, 30.0) or {}
        except Exception:
            return
        state["role"] = info.get("role")
        if state["role"] != "parent":
            return
        for schema, op in TOOLS.values():
            ctx.scope.add(tools.register(schema, handler_for(op)))
        mine = set(TOOLS) | set(KEEP)
        for name in tools.names():
            if name and name not in mine:
                ctx.scope.add(tools.disable(name))

    def before(gactx, nxt):
        if not state["checked"]:
            setup()
        return nxt(gactx)

    def prompt(text, nxt):
        # GA builds the system prompt before the agent_before hook (and before
        # it reads TOOLS_SCHEMA), so this is the earliest point to set up.
        if not state["checked"]:
            setup()
        text = nxt(text)
        if state["role"] == "parent":
            return text + "\n" + PARENT_PROMPT
        if state["role"] == "worker":
            return text + "\n" + WORKER_PROMPT
        return text

    ctx.on("ga.agent_before", before)
    ctx.on("ga.system_prompt", prompt)
