"""Frontend-neutral accumulation of structured agent events."""
from __future__ import annotations

import copy

USAGE_KEYS = ("calls", "input", "output", "cache_read", "cache_write")


def apply_event(messages, name, data):
    if not messages or messages[-1].get("status") != "running":
        return
    message = messages[-1]
    if name == "agent.chunk":
        message["text"] = message.get("text", "") + str(data)
        return
    data = data if isinstance(data, dict) else {}
    if name == "usage.total":
        message["usage"] = {k: data.get(k) for k in USAGE_KEYS}
        return
    turns = message.setdefault("turns", [])
    number = data.get("turn", 0)
    turn = next((t for t in reversed(turns) if t["turn"] == number), None)
    if turn is None:
        turn = {"turn": number, "summary": "", "reply": "", "thinking": "",
                "status": "running", "tools": []}
        turns.append(turn)
    if name == "assistant.text":
        turn.update({k: data.get(k) or "" for k in ("summary", "reply", "thinking")})
        # The completion text is authoritative; chunks are retained as fallback.
    elif name == "tool.call":
        turn["tools"].append({"id": data.get("id"), "name": data.get("name"),
                              "args": copy.deepcopy(data.get("args")), "status": "running"})
    elif name == "tool.result":
        tool = next((t for t in turn["tools"] if t["id"] == data.get("id")), None)
        if tool is None:
            tool = {"id": data.get("id"), "name": data.get("name"), "args": None}
            turn["tools"].append(tool)
        result = copy.deepcopy(data.get("data"))
        if result is not None and len(str(result)) > 16000:
            result = str(result)[:16000] + "\n[truncated]"
        tool.update(status="done", ok=bool(data.get("ok", True)), data=result,
                    seconds=data.get("seconds"))
    elif name == "turn.end":
        turn["status"] = "done"
    elif name == "usage":
        turn["usage"] = {k: data.get(k) for k in USAGE_KEYS}
    elif name == "llm.timed":
        turn["llm"] = {k: data.get(k) for k in ("seconds", "ttft")}
