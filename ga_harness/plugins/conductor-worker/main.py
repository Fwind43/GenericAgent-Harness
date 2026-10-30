"""conductor-worker: the worker half of conductor mode (modelled on GA Admin).

The host plugin ``conductor`` owns tasks, limits and child sessions and answers
the ``conductor`` RPC. This worker plugin asks the host for the run's role at the
start of the task (RPC replies are only delivered once the run's control thread
is up, so the call cannot happen in ``apply``):

* ``parent``  -- register the ``conductor_*`` tools, hide every other tool except
  ``ask_user`` / ``update_working_checkpoint`` / ``no_tool`` and the read-only
  ``file_read`` / ``web_scan`` (for spot checks), and add the conductor rules
  (with the host's limits) to the system prompt.
* ``worker``  -- a delegated child task: add a short brief so it works unattended
  and ends with a fixed-form, verifiable report; tools are unchanged.
* otherwise   -- do nothing.
"""
from __future__ import annotations

import importlib
import json

KEEP = ("ask_user", "update_working_checkpoint", "no_tool",
        "file_read", "web_scan")  # read-only, for spot-checking results
RPC_TIMEOUT = 150.0

# Limits are filled in from the host's ``role`` reply (fallbacks match the host).
DEFAULT_LIMITS = {"running": 3, "open": 12, "total": 48}

PARENT_PROMPT = """
### Conductor mode
You are the conductor of this session. You plan, delegate to child tasks, review
their results and decide; you do not do the work yourself. You may read files and
pages (`file_read`, `web_scan`) to spot-check a result, but never edit or run things.
- Split the request into independent, verifiable tasks; dispatch each with
  `conductor_dispatch` (a complete, self-contained objective: context, scope,
  deliverable, how to verify). Children cannot see this conversation.
- Limits: at most @RUNNING@ tasks run at once, @OPEN@ may be unresolved, @TOTAL@ per
  session. If the running limit is reached, end your turn and dispatch the rest after
  you are woken; do not retry in a loop.
- After dispatching, do not wait, sleep or poll. End your turn with a short status
  for the user (what was dispatched, what happens next). When tasks finish you are
  woken automatically with a `[Conductor]` message that already contains a clipped
  result of each finished task. Tasks finishing close together arrive in one
  wake-up: handle all of them in that turn. Use `conductor_collect` or
  `conductor_inspect` only when a clipped result is not enough.
- Review every finished task (done, error or cancelled) with `conductor_review`;
  it accepts `task_ids` to judge several at once.
  * `verified` only with concrete evidence in `basis` (files, commands, outputs the
    child reported, or what you spot-checked); add `resolve: true` to close it.
  * otherwise `needs_work` with the reason in `basis`, and either `instruction` to
    continue the same task, or `resolve: true` to abandon it (failed/cancelled only).
  A task cannot be resolved while unreviewed; `awaiting_review` in replies lists
  what is still open.
- If the user sends a new message while tasks run, adjust the plan: steer a task
  with `conductor_instruct`, stop obsolete ones with `conductor_cancel`, dispatch
  new ones as needed, and say what you changed.
- Report to the user only verified results; state clearly what is unverified.
"""

WORKER_PROMPT = """
### Delegated task
This session runs a task delegated by a conductor; nobody is watching it live. Work
only on the objective you were given and do not wait for or ask the user: if
something blocks you, stop and report it. End with a report in this form:
**Result** -- what was done (one or two sentences).
**Evidence** -- concrete files, commands and outputs that prove it.
**Unverified / blocked** -- anything not checked or not finished, or "none".
"""


def _parent_prompt(limits):
    text = PARENT_PROMPT
    for key, value in {**DEFAULT_LIMITS, **(limits or {})}.items():
        text = text.replace("@" + key.upper() + "@", str(value))
    return text


def _tool(name, description, properties=None, required=()):
    return {"type": "function", "function": {
        "name": name, "description": description,
        "parameters": {"type": "object", "properties": properties or {},
                       "required": list(required)}}}


TASK_ID = {"task_id": {"type": "string", "description": "Task id returned by conductor_dispatch."}}
TASK_IDS = {"task_ids": {"type": "array", "items": {"type": "string"},
                         "description": "Several task ids (instead of task_id)."}}

TOOLS = {
    "conductor_dispatch": (_tool(
        "conductor_dispatch",
        "Start a child task in its own session. The objective must be self-contained.",
        {"objective": {"type": "string", "description": "Complete task brief: context, scope, deliverable, verification."},
         "title": {"type": "string", "description": "Short title (optional)."}},
        ("objective",)), "dispatch"),
    "conductor_collect": (_tool(
        "conductor_collect",
        "Return finished tasks not yet collected. If nothing has finished while tasks are "
        "running, this ends your turn; you are woken automatically when a task finishes."), "collect"),
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
        "conductor_review",
        "Record one review verdict for one or more finished tasks (task_id or task_ids). "
        "Optionally close them (resolve) or continue them (instruction, needs_work only).",
        {**TASK_ID, **TASK_IDS,
         "verdict": {"type": "string", "enum": ["verified", "needs_work"]},
         "basis": {"type": "string", "description": "Concrete evidence or reason for the verdict (required)."},
         "resolve": {"type": "boolean", "description": "Also close the task(s). Unverified tasks can only "
                     "be closed when they failed or were cancelled."},
         "instruction": {"type": "string", "description": "needs_work only: continue the task with this instruction."}},
        ("verdict", "basis")), "review"),
    "conductor_resolve": (_tool(
        "conductor_resolve", "Close reviewed task(s) (task_id or task_ids).",
        {**TASK_ID, **TASK_IDS}), "resolve"),
}


def apply(ctx, config):
    host = ctx.get("run.host") if ctx.has("run.host") else None
    tools = ctx.get("ga.tools") if ctx.has("ga.tools") else None
    if host is None or tools is None:
        return  # not in a worker run
    state = {"role": None, "checked": False, "limits": None}

    def call(op, args):
        StepOutcome = importlib.import_module("agent_loop").StepOutcome
        body = {k: v for k, v in (args if isinstance(args, dict) else {}).items() if v is not None}
        body.update(op=op, session_id=host.session_id)
        try:
            result = host.call("conductor", body, RPC_TIMEOUT)
            msg = json.dumps(result, ensure_ascii=False, indent=1)
        except Exception as exc:  # RpcError and transport errors
            result, msg = None, f"[Error] conductor {op}: {exc}"
        if (op == "collect" and isinstance(result, dict) and not result.get("finished")
                and result.get("running") and not result.get("awaiting_review")):
            # Nothing to review (new or earlier) yet: end the turn instead of letting the model
            # poll. The host wakes this session when a child finishes.
            return StepOutcome(msg, next_prompt=None, should_exit=True)
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
        state["limits"] = info.get("limits")
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
            return text + "\n" + _parent_prompt(state["limits"])
        if state["role"] == "worker":
            return text + "\n" + WORKER_PROMPT
        return text

    ctx.on("ga.agent_before", before)
    ctx.on("ga.system_prompt", prompt)
