"""web-trace: Trace view for ui-web (timeline of inputs, model calls, tool calls and timings)."""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def apply(ctx, config):
    host = ctx.get("web.host")

    def prompt(req):
        """GET prompt?session_id=SID&index=I&turn=N: the recorded prompt text of one turn.

        Pages receive turns without it (see ui-web); the Trace view asks for it when a
        prompt row is opened. ``index`` is the message's position in the transcript.
        Without ``session_id`` the host's own transcript is read.
        """
        query = req.get("query") or {}
        sid = query.get("session_id")
        try:
            index, number = int(query.get("index")), int(query.get("turn"))
        except (TypeError, ValueError):
            return 400, {"error": "index and turn must be integers"}
        sessions = ctx.get("sessions")
        runs = ctx.get("runs")
        if not sid:
            # Profile without a session store: the page shows the host's own transcript.
            messages = getattr(host, "messages", None)
        elif sessions is None:
            return 503, {"error": "session store unavailable"}
        else:
            # A running session's newest turns exist only in the live transcript.
            live = runs.live_snapshot(sid) if runs is not None else None
            messages = live["messages"] if live else (sessions.get(sid) or {}).get("messages")
        if not isinstance(messages, list) or not 0 <= index < len(messages):
            return 404, {"error": "message not found"}
        message = messages[index]
        for turn in (message.get("turns") if isinstance(message, dict) else None) or []:
            if isinstance(turn, dict) and turn.get("turn") == number:
                recorded = turn.get("prompt")
                text = recorded.get("text") if isinstance(recorded, dict) else None
                if text is None:
                    break
                return {"text": text}
        return 404, {"error": "prompt not recorded"}

    ctx.scope.add(host.register("web-trace", script=HERE / "client.js", style=HERE / "client.css", order=45,
                                routes={("GET", "prompt"): prompt}))
