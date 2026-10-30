"""web-usage: token usage overview page for ui-web, aggregated from saved chats.

GET /api/p/web-usage/?days=N  -> {totals, models, days, sessions, ...}   (N=0: all time)

Counting matches the per-chat stats bar: per-step usage when present, otherwise the
run total. Runs without a creation time are dated by their chat's last update.
"""
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
KEYS = ("input", "output", "cache_read", "cache_write")


def _num(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and value == value else 0


def _empty():
    return {"runs": 0, "calls": 0, "input": 0, "output": 0, "cache_read": 0, "cache_write": 0}


def _add(into, usage, calls):
    for key in KEYS:
        into[key] += _num(usage.get(key))
    into["calls"] += calls


def run_usage(message):
    """(usage dict, call count) of one assistant message, or None when nothing was recorded."""
    turns = [t.get("usage") for t in message.get("turns") or [] if isinstance(t, dict) and isinstance(t.get("usage"), dict)]
    if turns:
        total = {key: sum(_num(u.get(key)) for u in turns) for key in KEYS}
        return total, sum(_num(u.get("calls")) or 1 for u in turns)
    usage = message.get("usage")
    if isinstance(usage, dict) and any(_num(usage.get(key)) for key in KEYS):
        return {key: _num(usage.get(key)) for key in KEYS}, _num(usage.get("calls"))
    return None


def aggregate(chats, days=30, now=None, top=10):
    now = time.time() if now is None else now
    since = now - days * 86400 if days else None
    totals, models, by_day, sessions = _empty(), {}, {}, []
    undated = 0
    for chat in chats:
        per = _empty()
        for message in chat.get("messages") or []:
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            found = run_usage(message)
            if found is None:
                continue
            at = _num(message.get("created_at"))
            if not at:
                at, undated = _num(chat.get("updated")), undated + 1
            if since is not None and at < since:
                continue
            usage, calls = found
            day = datetime.fromtimestamp(at).strftime("%Y-%m-%d")
            model = message.get("model") or ""
            for bucket in (totals, per, models.setdefault(model, _empty()), by_day.setdefault(day, _empty())):
                _add(bucket, usage, calls)
                bucket["runs"] += 1
        if per["runs"]:
            sessions.append(dict(per, id=chat.get("id"), title=chat.get("title") or "", updated=chat.get("updated")))
    weight = lambda row: row["input"] + row["output"]
    sessions.sort(key=weight, reverse=True)
    return {
        "days": days, "since": since, "now": now, "undated": undated,
        "totals": totals,
        "models": sorted((dict(v, model=k) for k, v in models.items()), key=weight, reverse=True),
        "daily": [dict(by_day[d], day=d) for d in sorted(by_day)],
        "sessions": sessions[:top], "session_count": len(sessions),
    }


def apply(ctx, config):
    host = ctx.get("web.host")

    def read(req):
        sessions = ctx.get("sessions")
        if sessions is None:
            return 503, {"error": "session store unavailable"}
        try:
            days = max(0, int((req.get("query") or {}).get("days", 30)))
        except (TypeError, ValueError):
            return 400, {"error": "days must be an integer"}
        return aggregate(sessions.transcripts(), days)

    ctx.scope.add(host.register("web-usage", script=HERE / "client.js", style=HERE / "client.css", order=48,
                                routes={("GET", ""): read}))
