"""web-context: visualise the saved LLM context of a chat for ui-web.

GET /api/p/web-context/?sid=ID  -> {model, effort, working, history, messages, totals}

Reads the session's persisted agent state (``sessions.capture``): ``raw`` is the backend
message history the model receives, ``history`` the GA summary lines and ``working`` the
working memory. While a run is active the stored state is the one from before that run.
Image payloads are replaced by their size; nothing is written.
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
KINDS = ("text", "thinking", "tool_use", "tool_result", "image", "other")


def _size(value):
    if isinstance(value, str):
        return len(value)
    try:
        return len(json.dumps(value, ensure_ascii=False))
    except (TypeError, ValueError):
        return len(str(value))


def _image(block):
    source = block.get("source") or block.get("image_url") or {}
    if isinstance(source, dict):
        data, media = source.get("data") or source.get("url") or "", source.get("media_type", "")
    else:
        data, media = str(source), ""
    return {"type": "image", "media": media, "bytes": len(data) * 3 // 4, "chars": 0}


def _block(block):
    if isinstance(block, str):
        return {"type": "text", "text": block, "chars": len(block)}
    if not isinstance(block, dict):
        return {"type": "other", "text": str(block), "chars": len(str(block))}
    kind = block.get("type")
    if kind in ("text", "input_text", "output_text"):
        text = block.get("text") or ""
        return {"type": "text", "text": text, "chars": len(text)}
    if kind in ("thinking", "redacted_thinking", "reasoning"):
        text = block.get("thinking") or block.get("text") or block.get("data") or ""
        return {"type": "thinking", "text": text if isinstance(text, str) else _dump(text),
                "chars": _size(text), "redacted": kind == "redacted_thinking"}
    if kind == "tool_use":
        args = block.get("input", {})
        return {"type": "tool_use", "id": block.get("id", ""), "name": block.get("name", ""),
                "text": _dump(args), "chars": _size(args)}
    if kind == "tool_result":
        content = block.get("content", "")
        parts = [_block(p) for p in content] if isinstance(content, list) else [_block(content)]
        text = "\n".join(p.get("text", "") for p in parts if p["type"] != "image")
        images = sum(1 for p in parts if p["type"] == "image")
        return {"type": "tool_result", "id": block.get("tool_use_id", ""), "text": text,
                "chars": sum(p["chars"] for p in parts), "images": images,
                "error": bool(block.get("is_error"))}
    if kind in ("image", "image_url", "input_image"):
        return _image(block)
    return {"type": "other", "text": _dump(block), "chars": _size(block)}


def _dump(value):
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        return str(value)


def describe(state):
    state = state or {}
    raw = state.get("raw") or []
    totals = {k: 0 for k in KINDS}
    counts = {k: 0 for k in KINDS}
    tools = {}
    messages = []
    for index, message in enumerate(raw if isinstance(raw, list) else []):
        if not isinstance(message, dict):
            continue
        content = message.get("content", "")
        blocks = [_block(b) for b in content] if isinstance(content, list) else [_block(content)]
        names = {}
        for b in blocks:
            totals[b["type"]] += b["chars"]
            counts[b["type"]] += 1
            if b["type"] == "tool_use":
                names[b["id"]] = b["name"]
                row = tools.setdefault(b["name"] or "?", {"name": b["name"] or "?", "calls": 0, "chars": 0})
                row["calls"] += 1
                row["chars"] += b["chars"]
        messages.append({"index": index, "role": message.get("role", "?"), "blocks": blocks,
                         "chars": sum(b["chars"] for b in blocks)})
    # Attribute tool_result sizes to the tool that produced them.
    names = {b["id"]: b["name"] for m in messages for b in m["blocks"] if b["type"] == "tool_use"}
    for m in messages:
        for b in m["blocks"]:
            if b["type"] == "tool_result":
                b["name"] = names.get(b["id"], "")
                row = tools.setdefault(b["name"] or "?", {"name": b["name"] or "?", "calls": 0, "chars": 0})
                row["chars"] += b["chars"]
    working = state.get("working") or {}
    if not isinstance(working, dict):
        working = {"working": working}
    history = state.get("history") or []
    history = [h if isinstance(h, str) else _dump(h) for h in history] if isinstance(history, list) else [str(history)]
    return {
        "model": state.get("model") or "", "effort": state.get("effort"),
        "working": {k: (v if isinstance(v, str) else _dump(v)) for k, v in working.items()},
        "history": history, "messages": messages,
        "totals": totals, "counts": counts,
        "tools": sorted(tools.values(), key=lambda r: r["chars"], reverse=True),
        "chars": sum(totals.values()),
    }


def apply(ctx, config):
    host = ctx.get("web.host")

    def read(req):
        sessions = ctx.get("sessions")
        if sessions is None:
            return 503, {"error": "session store unavailable"}
        sid = (req.get("query") or {}).get("sid") or ""
        try:
            row = sessions.get(sid) if sid else sessions.current()
        except ValueError:
            return 404, {"error": "session not found"}
        out = describe(row.get("state"))
        out.update(id=row.get("id"), title=row.get("title") or "", updated=row.get("updated"),
                   running=row.get("id") in getattr(sessions, "active", ()))
        return out

    ctx.scope.add(host.register("web-context", script=HERE / "client.js", style=HERE / "client.css", order=49,
                                routes={("GET", ""): read}))
