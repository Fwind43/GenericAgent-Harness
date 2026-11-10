"""ga-tools-refresh: manually force GA to resend its full tool definitions.

GA's ToolClient only sends the full tool schema when ``last_tools`` differs from
the current tools JSON; otherwise it sends a short reminder to save tokens. In
long chats the original full definition may have been trimmed from history and
weak models start writing tool calls as plain text. ``/tools`` clears
``last_tools`` so the next model call carries the full definition once, without
paying that cost on every trim.

    /tools            refresh, then ask the model to continue with real tool calls
    /tools <message>  refresh, then send <message>

Inside a run worker it also listens for the host push ``tools.refresh`` (sent by
the web-tools-refresh menu item while a task is running): the next model call of
the running task carries the full definition, and no message is sent.
"""

COMMAND = "/tools"
DEFAULT_PROMPT = ("[The full tool definitions have been re-sent.] Continue the previous task. "
                  "Call tools through the native tool-call interface; never write tool calls as plain text.")


def _clients(agent):
    seen = []
    for client in [getattr(agent, "llmclient", None), *(getattr(agent, "llmclients", None) or [])]:
        if client is not None and hasattr(client, "last_tools") and all(client is not c for c in seen):
            seen.append(client)
    return seen


def refresh(agent):
    """Clear ``last_tools`` on every ToolClient; returns how many were reset."""
    clients = _clients(agent)
    for client in clients:
        client.last_tools = ""
    return len(clients)


def parse(query):
    """``None`` if ``query`` is not the command, else the message to send."""
    if not isinstance(query, str):
        return None
    text = query.strip()
    if text != COMMAND and not text.startswith(COMMAND + " ") and not text.startswith(COMMAND + "\n"):
        return None
    return text[len(COMMAND):].strip() or DEFAULT_PROMPT


def apply(ctx, config):
    agent = ctx.get("ga.agent")

    def request(req, nxt):
        message = parse(req.get("query"))
        if message is None:
            return nxt(req)
        count = refresh(agent)
        ctx.emit("tools.refreshed", {"clients": count})
        return nxt({**req, "query": message})

    ctx.on("agent.request", request, priority=50)

    host = ctx.get("run.host") if ctx.has("run.host") else None
    if host is None:
        return

    def on_push(data=None):
        count = refresh(agent)
        try:
            host.emit("tools.refreshed", {"clients": count})
        except Exception:
            pass

    ctx.scope.add(host.on_push("tools.refresh", on_push))
