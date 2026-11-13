"""web-usage: token usage overview page for ui-web, aggregated from saved chats.

GET /api/p/web-usage/?days=N  -> {totals, models, days, sessions, ...}   (N=0: all time)

Counting matches the per-chat stats bar: per-step usage when present, otherwise the
run total. Runs without a creation time are dated by their chat's last update.
"""
import threading
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


def chat_runs(messages):
    """Compact [(created_at or 0, model, usage, calls)] for a transcript: all a report needs."""
    runs = []
    for message in messages or []:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        found = run_usage(message)
        if found is not None:
            runs.append((_num(message.get("created_at")), message.get("model") or "", found[0], found[1]))
    return runs


class Summaries:
    """Per-chat usage summaries, re-read only when a chat's `updated` stamp changes.

    Transcripts can total hundreds of MB; decoding all of them on every request stalled the
    whole server. Chats are read one at a time so the session store lock is never held long.
    """
    def __init__(self):
        self.lock = threading.Lock()   # one refresh at a time; later callers reuse its result
        self.cache = {}                # chat id -> (updated, runs)

    def chats(self, sessions):
        with self.lock:
            listing = sessions.listing()
            fresh = {}
            for row in listing:
                sid, hit = row["id"], self.cache.get(row["id"])
                if hit is None or hit[0] != row["updated"]:
                    chat = sessions.transcript(sid)
                    if chat is None:      # deleted since the listing
                        continue
                    hit = (chat["updated"], chat_runs(chat["messages"]))
                fresh[sid] = hit
            self.cache = fresh
            return [{"id": row["id"], "title": row["title"], "updated": fresh[row["id"]][0], "runs": fresh[row["id"]][1]}
                    for row in listing if row["id"] in fresh]


def aggregate(chats, days=30, now=None, top=10):
    now = time.time() if now is None else now
    since = now - days * 86400 if days else None
    totals, models, by_day, sessions = _empty(), {}, {}, []
    undated = 0
    for chat in chats:
        per = _empty()
        runs = chat["runs"] if "runs" in chat else chat_runs(chat.get("messages"))
        for at, model, usage, calls in runs:
            if not at:
                at, undated = _num(chat.get("updated")), undated + 1
            if since is not None and at < since:
                continue
            day = datetime.fromtimestamp(at).strftime("%Y-%m-%d")
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
    summaries = Summaries()

    def read(req):
        sessions = ctx.get("sessions")
        if sessions is None:
            return 503, {"error": "session store unavailable"}
        try:
            days = max(0, int((req.get("query") or {}).get("days", 30)))
        except (TypeError, ValueError):
            return 400, {"error": "days must be an integer"}
        return aggregate(summaries.chats(sessions), days)

    ctx.scope.add(host.register("web-usage", script=HERE / "client.js", style=HERE / "client.css", order=48,
                                routes={("GET", ""): read}))
