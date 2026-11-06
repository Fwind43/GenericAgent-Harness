"""admin-import: copy GA Admin chats into harness sessions, ready to continue.

GET  /api/p/admin-import/?path=DIR    -> {dir, chats: [{id, title, updated, messages, imported}], skipped}
POST /api/p/admin-import/ {path, ids}  -> {imported: [...], existing: [...], failed: [{id, error}]}

DIR may be the Admin install/data folder or its `chat_sessions` folder. Admin files are
only read. Each chat keeps GA's model context (raw history, history summary, working
memory) so it can be continued; attachments are kept as text notes only. An imported
chat gets the ID `admin-<admin id>`, so importing it again is skipped.
"""
import json
import os
import re
import time
from datetime import datetime
from pathlib import Path

from ga_harness.sessions import EFFORTS

HERE = Path(__file__).resolve().parent
PREFIX = "admin-"
CANDIDATES = ("chat_sessions", "chat/chat_sessions", "data/chat/chat_sessions")
USAGE_KEYS = ("calls", "input", "output", "cache_read", "cache_write")

TURN_HEAD = re.compile(r"^\s*\*\*LLM Running \(Turn (\d+)\) \.\.\.\*\*\s*")
TOOL = re.compile(r"\U0001F6E0\uFE0F? Tool: `([^`]*)`\s*\U0001F4E5 args:\n````text\n(.*?)\n````\n", re.S)
TAG = re.compile(r"<(summary|thinking)>(.*?)</\1>", re.S)


def _dir(path):
    """Admin folder given by the user -> its chat_sessions folder."""
    raw = str(path or "").strip().strip('"')
    if not raw:
        raise ValueError("path required")
    base = Path(os.path.expandvars(raw)).expanduser()
    for sub in CANDIDATES:
        if (base / sub).is_dir():
            return base / sub
    if base.is_dir() and (base.name == "chat_sessions" or any(base.glob("*.json"))):
        return base
    raise ValueError(f"no Admin chat_sessions folder under {base}")


def _load(file):
    try:
        data = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("messages"), list) else None


def _time(value, default=0.0):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return value / 1000 if value > 1e11 else float(value)
    if isinstance(value, str) and value.strip():
        try:
            return datetime.fromisoformat(value.strip().replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return default


def _admin_id(data, file):
    sid = data.get("id")
    return str(sid) if isinstance(sid, (str, int)) and str(sid) else file.stem


def _title(data):
    title = data.get("title")
    if isinstance(title, str) and title.strip():
        return title.strip()[:120]
    for m in data.get("messages") or []:
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str) and m["content"].strip():
            return m["content"].strip().splitlines()[0][:60]
    return "Admin chat"


def _num(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def _usage(u):
    if not isinstance(u, dict):
        return None
    return {"calls": 1, "input": _num(u.get("input_tokens")), "output": _num(u.get("output_tokens")),
            "cache_read": _num(u.get("cache_read_tokens")), "cache_write": _num(u.get("cache_creation_tokens"))}


def _args(text):
    try:
        return json.loads(text)
    except ValueError:
        return text


def _turn(n, text, usage):
    """One GA turn of streamed text -> harness turn {summary, thinking, reply, tools}."""
    m = TURN_HEAD.match(text)
    if m:
        n, text = int(m.group(1)), text[m.end():]
    tools, prose, pos = [], [], 0
    for i, hit in enumerate(TOOL.finditer(text), 1):
        if hit.start() < pos:  # inside a previous tool's output
            continue
        prose.append(text[pos:hit.start()])
        rest, data, pos = text[hit.end():], "", hit.end()
        if rest.startswith("`````\n"):
            end = rest.find("`````", 6)
            data = rest[6:end if end >= 0 else len(rest)].rstrip("\n")
            pos = hit.end() + (end + 5 if end >= 0 else len(rest))
        tools.append({"id": f"{n}.{len(tools) + 1}", "name": hit.group(1), "args": _args(hit.group(2)),
                      "status": "done", "ok": True, "data": data})
    prose.append(text[pos:])
    body = "".join(prose)
    tags = {"summary": [], "thinking": []}
    for tag in TAG.finditer(body):
        tags[tag.group(1)].append(tag.group(2).strip())
    turn = {"turn": n, "summary": "\n".join(tags["summary"]), "thinking": "\n\n".join(tags["thinking"]),
            "reply": TAG.sub("", body).strip(), "status": "done", "tools": tools}
    if usage:
        turn["usage"] = usage
    return turn


def _note(files):
    lines = []
    for f in files if isinstance(files, list) else []:
        if not isinstance(f, dict):
            continue
        name = f.get("name") or f.get("filename") or os.path.basename(str(f.get("url") or f.get("path") or "")) or "file"
        size = _num(f.get("size"))
        extra = ", ".join(x for x in (str(f.get("mime") or f.get("type") or ""), f"{size} bytes" if size else "") if x)
        lines.append(f"- {name}" + (f" ({extra})" if extra else ""))
    return "\n\n[Attachments not imported]\n" + "\n".join(lines) if lines else ""


def convert(data, fallback_time):
    """Admin chat dict -> (messages, state, updated)."""
    settings = data.get("settings") if isinstance(data.get("settings"), dict) else {}
    effort = settings.get("reasoning_effort")
    effort = effort if effort in EFFORTS else None
    messages, model, last = [], "", fallback_time
    for m in data.get("messages") or []:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
            continue
        at = _time(m.get("created_at"), last)
        last = at or last
        text = m.get("content") if isinstance(m.get("content"), str) else ""
        if m["role"] == "user":
            messages.append({"role": "user", "text": text + _note(m.get("files")), "created_at": at})
            continue
        outputs = [o for o in (m.get("outputs") or []) if isinstance(o, str)]
        usages = m.get("usages") if isinstance(m.get("usages"), list) else []
        turns = [_turn(i + 1, o, _usage(usages[i]) if i < len(usages) else None) for i, o in enumerate(outputs)]
        if not turns and text:
            turns = [{"turn": 1, "summary": "", "thinking": "", "reply": text, "status": "done", "tools": []}]
        if isinstance(m.get("model_id"), str) and m["model_id"]:
            model = m["model_id"]
        msg = {"role": "assistant", "text": "".join(outputs) or text, "created_at": at, "model": model,
               "reasoning_effort": effort, "status": "done", "turns": turns}
        total = {k: sum(t["usage"][k] for t in turns if t.get("usage")) for k in USAGE_KEYS}
        if total["calls"]:
            msg["usage"] = total
        error = m.get("error")
        if error:
            msg["status"], msg["error"] = "error", error if isinstance(error, str) else "error"
        messages.append(msg)
    working = data.get("working") if isinstance(data.get("working"), dict) else {}
    history = data.get("history_info") if isinstance(data.get("history_info"), list) else []
    raw = data.get("raw_history") if isinstance(data.get("raw_history"), list) else []
    state = {"history": history, "raw": raw,
             "working": {k: working[k] for k in ("key_info", "passed_sessions") if k in working},
             "model": model, "model_key": None, "effort": effort}
    return messages, state, _time(data.get("updated_at"), last)


def apply(ctx, config):
    host = ctx.get("web.host")

    def store():
        sessions = ctx.get("sessions")
        if sessions is None:
            raise LookupError("session store unavailable")
        return sessions

    def _open(path):
        try:
            return store(), _dir(path), None
        except LookupError as e:
            return None, None, (503, {"error": str(e)})
        except ValueError as e:
            return None, None, (400, {"error": str(e)})

    def scan(req):
        sessions, folder, err = _open((req.get("query") or {}).get("path"))
        if err:
            return err
        chats, skipped = [], 0
        for file in sorted(folder.glob("*.json")):
            data = _load(file)
            if data is None:
                skipped += 1
                continue
            sid = _admin_id(data, file)
            chats.append({"id": sid, "title": _title(data),
                          "updated": _time(data.get("updated_at"), file.stat().st_mtime),
                          "messages": sum(1 for m in data["messages"] if isinstance(m, dict) and m.get("role") in ("user", "assistant")),
                          "imported": sessions.exists(PREFIX + sid)})
        chats.sort(key=lambda c: -c["updated"])
        return {"dir": str(folder), "chats": chats, "skipped": skipped}

    def run(req):
        body = req.get("body") or {}
        ids = body.get("ids")
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i for i in ids):
            return 400, {"error": "ids must be a non-empty list of chat IDs"}
        sessions, folder, err = _open(body.get("path"))
        if err:
            return err
        wanted, files = set(ids), {}
        for file in folder.glob("*.json"):
            if file.stem in wanted:
                files[file.stem] = file
        if len(files) < len(wanted):  # IDs that differ from file names
            for file in folder.glob("*.json"):
                data = _load(file)
                if data is not None and _admin_id(data, file) in wanted:
                    files.setdefault(_admin_id(data, file), file)
        base = sessions.current(light=True)
        scope = getattr(sessions, "root_scope", None)
        if scope:
            workspace, project_id = scope(base, None)
        else:
            workspace, project_id = base.get("workspace", ""), base.get("project_id", "")
        imported, existing, failed = [], [], []
        for sid in dict.fromkeys(ids):
            file = files.get(sid)
            data = _load(file) if file else None
            if data is None or _admin_id(data, file) != sid:
                failed.append({"id": sid, "error": "not found or unreadable"})
                continue
            try:
                messages, state, updated = convert(data, file.stat().st_mtime)
                ok = sessions.insert(PREFIX + sid, title=_title(data), messages=messages, state=state,
                                     updated=updated or time.time(), workspace=workspace or "",
                                     project_id=project_id or "", pinned=updated if data.get("pinned") else 0)
            except (TypeError, ValueError, OSError) as e:
                failed.append({"id": sid, "error": str(e)})
                continue
            (imported if ok else existing).append(sid)
        if imported:
            frontend = getattr(host, "frontend", None)
            try:
                frontend.broadcast("snapshot", frontend.snapshot())
            except Exception:
                pass  # the list refreshes on the next snapshot anyway
        return {"imported": imported, "existing": existing, "failed": failed}

    ctx.scope.add(host.register("admin-import", script=HERE / "client.js", style=HERE / "client.css", order=60,
                                routes={("GET", ""): scan, ("POST", ""): run}))
