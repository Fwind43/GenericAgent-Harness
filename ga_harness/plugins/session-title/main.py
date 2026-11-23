"""AI session titles.

After the first finished reply of a chat whose title is still the default (its
first message), the chat's model (or the configured title model) is asked for a
short title and the chat is renamed. ``POST generate`` retitles any chat on demand.
Manually renamed chats are left alone by the automatic path.
"""
from __future__ import annotations

import json
import logging
import re
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
log = logging.getLogger(__name__)
MAX_TITLE = 40
MAX_CONTEXT = 4000
PROMPT = (
    "Write a short title for the conversation below. Use the conversation's main language; "
    "at most 20 characters for Chinese/Japanese/Korean or 8 words otherwise. "
    "Reply with the title only: no quotes, no punctuation at the end, no explanation.\n\n"
)


# ---------- endpoints (same rules as vlm-tool) ----------


def _mode(value):
    m = str(value or "chat_completions").strip().lower().replace("-", "_")
    return "responses" if m in ("responses", "response") else "chat_completions"


def _from_entry(key, cfg):
    from ga_harness import llmconfig
    cfg = llmconfig._expand(dict(cfg), key)
    claude = "claude" in key and "oai" not in key
    apikey = str(cfg.get("apikey") or "")
    proxy = cfg.get("proxy")
    return {"name": cfg.get("name") or key, "kind": "claude" if claude else "oai",
            "base": str(cfg.get("apibase") or "").rstrip("/"), "key": apikey,
            "xkey": claude and (not key.startswith("native") or apikey.startswith("sk-ant-")
                                or cfg.get("api_key_header") == "x-api-key"),
            "model": cfg.get("model") or "", "mode": _mode(cfg.get("api_mode")),
            "proxies": {"http": proxy, "https": proxy} if proxy else None, "verify": cfg.get("verify", True)}


def _url(base, path):
    """Same joining rule as GA llmcore.auto_make_url."""
    b, p = str(base).rstrip("/"), path.strip("/")
    if b.endswith("$"):
        return b[:-1].rstrip("/")
    if b.endswith(p):
        return b
    return f"{b}/{p}" if re.search(r"/v\d+(/|$)", b) else f"{b}/v1/{p}"


def _text_of(content):
    if isinstance(content, str):
        return content
    return "".join(c.get("text", "") for c in content or [] if isinstance(c, dict))


def _parse_json(d):
    if isinstance(d.get("error"), dict) or isinstance(d.get("error"), str):
        raise RuntimeError(f"API error: {str(d['error'])[:300]}")
    if "choices" in d:
        return _text_of(((d.get("choices") or [{}])[0].get("message") or {}).get("content"))
    if d.get("type") == "message" or "stop_reason" in d:
        return "".join(c.get("text", "") for c in d.get("content") or [] if c.get("type") == "text")
    if d.get("output_text"):
        return d["output_text"]
    return "".join(_text_of(o.get("content")) for o in d.get("output") or [] if o.get("type") == "message")


def _parse_sse(body):
    out = []
    for line in body.splitlines():
        if not line.startswith("data:"):
            continue
        s = line[5:].strip()
        if not s or s == "[DONE]":
            continue
        try:
            e = json.loads(s)
        except ValueError:
            continue
        t = e.get("type", "")
        if "choices" in e:
            out.append(((e.get("choices") or [{}])[0].get("delta") or {}).get("content") or "")
        elif t == "content_block_delta":
            out.append((e.get("delta") or {}).get("text") or "")
        elif t == "response.output_text.delta":
            out.append(e.get("delta") or "")
        elif t == "error" or "error" in e:
            raise RuntimeError(f"API error: {str(e.get('error') or e)[:300]}")
    return "".join(out)


def _endpoint(key):
    """Endpoint dicts for a mykey.py key; failover groups expand to their members."""
    from ga_harness import llmconfig
    entries = llmconfig.model_entries()
    if key in entries:
        return [_from_entry(key, entries[key])]
    path = llmconfig.mykey_path()
    if not key or path is None or not path.is_file():
        return []
    try:
        data = llmconfig.read_mykey_py(path)
        value = data.get(key)
        if not isinstance(value, dict):
            return []
        from ga_harness import models
        members = models._member_keys(data, value)
    except Exception:
        log.debug("session-title: cannot resolve %s", key, exc_info=True)
        return []
    return [_from_entry(k, entries[k]) for k in members if k and k in entries]


def _ask(ep, prompt, timeout):
    import requests
    headers = {"Content-Type": "application/json"}
    if ep["kind"] == "claude":
        url = _url(ep["base"], "messages")
        headers["anthropic-version"] = "2023-06-01"
        if ep["xkey"]:
            headers["x-api-key"] = ep["key"]
        else:
            headers["Authorization"] = "Bearer " + ep["key"]
        payload = {"model": ep["model"], "max_tokens": 64, "messages": [{"role": "user", "content": prompt}]}
    elif ep["mode"] == "responses":
        url = _url(ep["base"], "responses")
        headers["Authorization"] = "Bearer " + ep["key"]
        payload = {"model": ep["model"], "max_output_tokens": 64, "input": [{"role": "user", "content": prompt}]}
    else:
        url = _url(ep["base"], "chat/completions")
        headers["Authorization"] = "Bearer " + ep["key"]
        payload = {"model": ep["model"], "max_tokens": 64, "messages": [{"role": "user", "content": prompt}]}
    r = requests.post(url, headers=headers, json=payload, timeout=(15, timeout),
                      proxies=ep["proxies"], verify=ep["verify"])
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")
    if "event-stream" in r.headers.get("Content-Type", ""):
        return _parse_sse(r.text)
    return _parse_json(r.json())


def _clean(text):
    text = re.sub(r"<think(ing)?>.*?</think(ing)?>", "", str(text or ""), flags=re.S | re.I)
    line = next((l for l in text.strip().splitlines() if l.strip()), "")
    line = re.sub(r"^(title|\u6807\u9898)\s*[:\uff1a]\s*", "", line.strip(), flags=re.I)
    line = line.strip().strip("\"'`*#\u201c\u201d\u2018\u2019\u300a\u300b\u300c\u300d ").rstrip("\u3002.!\uff01")
    return line[:MAX_TITLE].strip()


def _context(messages):
    parts, size = [], 0
    for m in messages:
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        text = str(m.get("text") or "").strip()
        if not text:
            continue
        chunk = f"{role}: {text[:1500]}"
        parts.append(chunk)
        size += len(chunk)
        if size >= MAX_CONTEXT:
            break
    return "\n\n".join(parts)[:MAX_CONTEXT]


def _default_title(messages):
    first = next((str(m.get("text") or "") for m in messages if m.get("role") == "user"), "")
    return " ".join(first.split())[:60]


# ---------- plugin ----------


def apply(ctx, config):
    host, sessions = ctx.get("web.host"), ctx.get("sessions")
    frontend = host.frontend
    busy, done = set(), set()
    lock = threading.Lock()

    def _cfg(name, default):
        try:
            value = config.get(name, default)
        except Exception:
            value = default
        return default if value is None else value

    def generate(sid):
        transcript = sessions.transcript(sid)
        context = _context(transcript.get("messages") or [])
        if not context:
            raise ValueError("chat has no messages yet")
        key = str(_cfg("model", "") or "").strip()
        if not key:
            state = sessions.state_of(sid) or {}
            key = str(state.get("model_key") or "")
        eps = _endpoint(key)
        if not eps:
            from ga_harness import llmconfig
            entries = llmconfig.model_entries()
            eps = [_from_entry(k, v) for k, v in list(entries.items())[:1]]
        if not eps:
            raise RuntimeError("no model available for titles")
        timeout = int(_cfg("timeout", 60) or 60)
        errors = []
        for ep in eps:
            try:
                title = _clean(_ask(ep, PROMPT + context, timeout))
            except Exception as error:
                errors.append(f"{ep['name']}: {error}")
                continue
            if title:
                return title
            errors.append(f"{ep['name']}: empty title")
        raise RuntimeError("; ".join(errors)[:500] or "title generation failed")

    def _rename(sid, title):
        sessions.change("rename", sid, title)
        try:
            frontend.broadcast("snapshot", frontend.snapshot())
        except Exception:
            log.debug("session-title: snapshot broadcast failed", exc_info=True)

    def _auto(sid):
        try:
            transcript = sessions.transcript(sid)
            messages = transcript.get("messages") or []
            # Only untouched chats: title still the first message.
            if transcript.get("title") not in (_default_title(messages), "\u65b0\u4f1a\u8bdd"):
                return
            title = generate(sid)
            # The user may have renamed it meanwhile.
            if sessions.transcript(sid).get("title") == transcript.get("title"):
                _rename(sid, title)
        except Exception as error:
            log.info("session-title: auto title for %s failed: %s", sid, error)
        finally:
            with lock:
                busy.discard(sid)

    def on_finished(data, nxt=None):
        try:
            sid = data.get("session_id")
            status = (data.get("run") or {}).get("status") or data.get("status")
            if sid and status not in ("aborted", "error", "failed") and _cfg("auto", True):
                with lock:
                    start = sid not in busy and sid not in done
                    if start:
                        busy.add(sid)
                        done.add(sid)
                if start:
                    threading.Thread(target=_auto, args=(sid,), name="session-title", daemon=True).start()
        except Exception:
            log.debug("session-title: on_finished failed", exc_info=True)
        return nxt(data) if nxt else None

    def route_generate(request):
        body = request.get("body") or {}
        sid = body.get("session_id")
        if not isinstance(sid, str) or not sid:
            return 400, {"error": "session_id required"}
        with lock:
            if sid in busy:
                return 409, {"error": "title generation already running"}
            busy.add(sid)
        try:
            title = generate(sid)
            _rename(sid, title)
            return 200, {"ok": True, "title": title}
        except ValueError as error:
            return 400, {"error": str(error)}
        except Exception as error:
            return 502, {"error": str(error)}
        finally:
            with lock:
                busy.discard(sid)
                done.add(sid)

    ctx.on("run.finished", on_finished)
    script = HERE / "client.js"
    ctx.scope.add(host.register("session-title", script=script if script.is_file() else None, order=60,
                                routes={("POST", "generate"): route_generate}))
