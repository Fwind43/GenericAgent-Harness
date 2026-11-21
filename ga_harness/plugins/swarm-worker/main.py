"""swarm-worker: the worker half of swarm mode.

The host plugin ``swarm`` owns swarms, members, the shared board and wake-ups and
answers the ``swarm`` RPC. At the start of a run this plugin asks the host for the
session's role:

* ``coordinator`` -- non-blocking board tools, member management and ``swarm_await_user``.
* ``member``      -- board tools including ``board_wait``; the role brief goes into the prompt.
* otherwise       -- nothing.

Unlike conductor mode nothing is hidden: every participant keeps its normal tools
and talks to the others directly through the board (mesh, not star).
"""
from __future__ import annotations

import importlib
import json
import logging

RPC_TIMEOUT = 60.0
ROLE_TRIES = 3
log = logging.getLogger("gah.swarm-worker")
WAIT_MAX = 900


def _tool(name, description, properties=None, required=()):
    return {"type": "function", "function": {
        "name": name, "description": description,
        "parameters": {"type": "object", "properties": properties or {},
                       "required": list(required)}}}


TEXT = {"text": {"type": "string", "description":
                 "Message. Mention participants with @name, a group with @group, everyone with @all; "
                 "mentioned participants are woken to read it."}}
SINCE = {"since": {"type": "integer", "description": "Only posts with id greater than this (default: your read cursor)."}}

BOARD_TOOLS = {
    "board_post": (_tool("board_post",
        "Post a message to the swarm's shared board. Every participant can read it; @mentions "
        "wake the mentioned participants. Use it to hand off work, ask a teammate, report results.",
        {**TEXT, "reply_to": {"type": "integer", "description": "Optional id of the post you answer."}},
        ["text"]), "post"),
    "board_read": (_tool("board_read",
        "Read board posts newer than your cursor (or since=id) and advance your cursor.",
        {**SINCE, "limit": {"type": "integer", "description": "Max posts (default 30)."}}), "read"),
    "swarm_members": (_tool("swarm_members",
        "List the swarm's participants with their role, groups, model and current status."), "members"),
}

MEMBER_TOOLS = {
    "board_wait": (_tool("board_wait",
        "Block until a new board post mentions you (or any new post if any=true) or the timeout ends. "
        "Prefer ending your turn when you have nothing to do: you are woken automatically when mentioned.",
        {"timeout": {"type": "integer", "description": f"Seconds, 10..{WAIT_MAX} (default 300)."},
         "any": {"type": "boolean", "description": "Return on any new post, not only mentions."}}), "wait"),
}

COORD_TOOLS = {
    "swarm_add_member": (_tool("swarm_add_member",
        "Add a member: a new session with its own role brief, optional model/effort, groups and an "
        "optional isolated git worktree. Only the coordinator can add members.",
        {"name": {"type": "string", "description": "Short unique handle used in @mentions (letters, digits, - _)."},
         "role": {"type": "string", "description": "Role title, e.g. 'backend engineer'."},
         "brief": {"type": "string", "description": "Standing instructions for this member."},
         "groups": {"type": "array", "items": {"type": "string"}, "description": "Groups for @group mentions."},
         "model": {"type": "string", "description": "Configured model key or name (default: inherit)."},
         "effort": {"type": "string", "description": "Reasoning effort (default: inherit)."},
         "worktree": {"type": "boolean", "description": "Work in an isolated git worktree of the workspace."}},
        ["name", "role"]), "add"),
    "swarm_remove_member": (_tool("swarm_remove_member",
        "Remove a member (its running turn is cancelled; its session and posts are kept).",
        {"name": {"type": "string"}}, ["name"]), "remove"),
    "swarm_set_member_model": (_tool("swarm_set_member_model",
        "Change a member's model and/or reasoning effort. Pass only what changes; an empty string "
        "resets it to the default. A running member switches from its next turn.",
        {"name": {"type": "string"},
         "model": {"type": "string", "description": "Configured model key or name ('' = inherit)."},
         "effort": {"type": "string", "description": "Reasoning effort ('' = inherit)."}},
        ["name"]), "set_model"),
    "swarm_models": (_tool("swarm_models", "List configured models (key, name) for per-role selection."), "models"),
    "swarm_await_user": (_tool("swarm_await_user",
        "Deliver a phase or ask for a decision. Record a handoff and wait for the user "
        "without closing the swarm or discarding queued work.",
        {"summary": {"type": "string", "description": "What was delivered or what input is needed."}},
        ["summary"]), "await_user"),
}

COORD_PROMPT = """
### Swarm mode -- you are the coordinator
You lead a swarm: a team of member sessions that talk to each other directly on a shared
board (a mesh, not a hub). Members can @mention each other, groups (@group) or @all; a
mention wakes the mentioned participant. You alone add or remove members.
- Design the team first (swarm_add_member: distinct names, focused roles, model per role,
  worktree for members that edit the same repository), then post the plan to the board
  and @mention who starts. Let members coordinate among themselves; step in when they
  are stuck, disagree, or loop. If a member's model is too weak or too costly for its
  role, switch it with swarm_set_member_model.
- Do not relay every message: members read the board themselves.
- End your turn instead of polling; you are woken when mentioned (@coordinator) or when
  the board goes quiet. When a phase is delivered or a decision is needed, call
  swarm_await_user with the result or question, then reply to the user and end your turn.
  The team stays available for follow-up. Only the user can turn swarm mode off.
"""

MEMBER_PROMPT = """
### Swarm mode -- you are member @{name} ({role})
You are part of a swarm; teammates work in their own sessions and talk through a shared
board. Use board_read to catch up, board_post to hand off, ask or report (mention @name,
@group, @all or @coordinator). Mentions wake the mentioned teammate, so mention only
those who must act. When your part is done post a short, verifiable result and end your
turn; do not wait in loops.
{groups}Your brief:
{brief}
{team}"""


def _team(info):
    """Teammate roster for the member prompt, so mentions go to the right person."""
    me = info.get("name")
    rows = []
    for m in info.get("members") or []:
        name = m.get("name") if isinstance(m, dict) else None
        if not name or name == me:
            continue
        line = "- @" + name
        if m.get("role"):
            line += " -- " + str(m["role"])
        if m.get("groups"):
            line += " (" + ", ".join("@" + g for g in m["groups"]) + ")"
        rows.append(line)
    if not rows:
        return ""
    return ("Teammates (snapshot from the start of this run; call swarm_members for the "
            "current list):\n" + "\n".join(rows) + "\n")


def apply(ctx, config):
    host = ctx.get("run.host") if ctx.has("run.host") else None
    tools = ctx.get("ga.tools") if ctx.has("ga.tools") else None
    if host is None or tools is None:
        return
    state = {"role": None, "checked": False, "tries": 0, "info": {}}

    def call(op, args):
        StepOutcome = importlib.import_module("agent_loop").StepOutcome
        body = {k: v for k, v in (args if isinstance(args, dict) else {}).items() if v is not None}
        body.update(op=op, session_id=host.session_id)
        timeout = RPC_TIMEOUT
        if op == "wait":
            try:
                wait = int(body.get("timeout") or 300)
            except (TypeError, ValueError):
                wait = 300
            body["timeout"] = max(10, min(WAIT_MAX, wait))
            timeout = body["timeout"] + 30.0
        try:
            result = host.call("swarm", body, timeout)
            msg = json.dumps(result, ensure_ascii=False, indent=1)
        except Exception as exc:
            msg = f"[Error] swarm {op}: {exc}"
        return StepOutcome(msg, next_prompt=msg + "\n")

    def handler_for(op, name):
        def run(handler, args, response):
            return call(op, args)
        run.__name__ = name
        return run

    def setup():
        # A failed role lookup must not silently turn a swarm session into a plain
        # one for the whole run: leave it unchecked and retry on the next hook call,
        # up to ROLE_TRIES attempts.
        state["tries"] += 1
        try:
            info = host.call("swarm", {"op": "role", "session_id": host.session_id}, 30.0) or {}
        except Exception as exc:
            if state["tries"] >= ROLE_TRIES:
                state["checked"] = True
                log.warning("swarm role lookup failed %d times for session %s, giving up: %s",
                            state["tries"], host.session_id, exc)
            else:
                log.warning("swarm role lookup failed for session %s (attempt %d/%d): %s",
                            host.session_id, state["tries"], ROLE_TRIES, exc)
            return
        state["checked"] = True
        state["role"], state["info"] = info.get("role"), info
        if state["role"] not in ("coordinator", "member"):
            return
        table = dict(BOARD_TOOLS)
        table.update(COORD_TOOLS if state["role"] == "coordinator" else MEMBER_TOOLS)
        names = set(tools.names())
        for name, (schema, op) in table.items():
            if name not in names:
                ctx.scope.add(tools.register(schema, handler_for(op, name)))

    def before(gactx, nxt):
        if not state["checked"]:
            setup()
        return nxt(gactx)

    def prompt(text, nxt):
        if not state["checked"]:
            setup()
        text = nxt(text)
        info = state["info"]
        if state["role"] == "coordinator":
            out = text + "\n" + COORD_PROMPT
            if info.get("members"):
                out += "\nCurrent members: " + json.dumps(info["members"], ensure_ascii=False) + "\n"
            return out
        if state["role"] == "member":
            groups = info.get("groups") or []
            return text + "\n" + MEMBER_PROMPT.format(
                name=info.get("name", "?"), role=info.get("member_role", ""),
                groups=("Your groups: " + ", ".join("@" + g for g in groups) + "\n") if groups else "",
                brief=(info.get("brief") or "(none)").strip(),
                team=_team(info))
        return text

    ctx.on("ga.agent_before", before)
    ctx.on("ga.system_prompt", prompt)
