"""ga-events: turn GA's hook locals into structured, frontend-agnostic events.

GA only streams display text (turn banners, tool fences, raw output). This plugin
listens on the ga-hooks waterfalls and emits plain-dict events so every frontend
renders tool calls the same way instead of re-parsing GA's text.

Events (emit, payload is one dict):
  run.start       {}
  turn.start      {turn}
  assistant.delta {turn, part, text}   live model output, part = summary | thinking | reply
  assistant.text  {turn, text, reply, thinking, summary}   reply = text minus leading protocol blocks
  tool.call       {id, turn, index, name, args}
  tool.result     {id, turn, index, name, ok, data, seconds}
  turn.end        {turn, exit}
  run.end         {exit}

``id`` is "<turn>.<index>" (GA does not pass the provider tool-call id to dispatch).
``assistant.delta`` comes from wrapping ``client.chat`` on the client instance for the
duration of one LLM call (installed in llm_before, removed when the stream ends), so it
runs on the agent thread in exactly the order GA consumes tokens. Only leading
<summary>/<thinking> blocks are protocol; once reply text starts, all later tags
are literal reply content. A frontend can append ``text`` to the matching field.
``assistant.text`` uses the same splitter and is authoritative, replacing deltas.
``no_tool`` (GA's pseudo tool for a plain reply) is not reported as a tool.
config:
  max_data  truncate string results to this many chars (default 20000, 0 = no limit)
"""
from __future__ import annotations
import json
import re
import time

_PRIVATE = ("_index", "_tool_num")


def _text(v, limit):
    if v is None:
        return None
    if not isinstance(v, str):
        try:
            v = json.dumps(v, ensure_ascii=False, default=str)
        except Exception:
            v = str(v)
    if limit and len(v) > limit:
        v = v[:limit] + f"\n... [{len(v) - limit} chars truncated]"
    return v


def _plain(v):
    """JSON-safe copy (args/data may hold arbitrary objects)."""
    try:
        return json.loads(json.dumps(v, ensure_ascii=False, default=str))
    except Exception:
        return str(v)


class _Split:
    """Split leading protocol blocks; after reply starts, tags are literal text."""
    TAGS = ("summary", "thinking")

    def __init__(self):
        self.buf = ""
        self.part = "reply"
        self.reply_started = False

    def feed(self, s: str) -> list:
        self.buf += s
        return self._drain(False)

    def flush(self) -> list:
        return self._drain(True)

    def _cands(self):
        if self.part == "reply":
            return [(f"<{t}>", t) for t in self.TAGS]
        return [(f"</{self.part}>", "reply")]

    def _drain(self, final: bool) -> list:
        out: list = []
        while self.buf:
            if self.part == "reply" and self.reply_started:
                self._add(out, self.buf)
                self.buf = ""
                break
            i = self.buf.find("<")
            if i != 0:
                text, self.buf = (self.buf, "") if i < 0 else (self.buf[:i], self.buf[i:])
                self._add(out, text)
                continue
            for tag, nxt in self._cands():
                if self.buf.startswith(tag):
                    self.part, self.buf = nxt, self.buf[len(tag):]
                    break
                if not final and tag.startswith(self.buf):
                    return out          # maybe a tag split across chunks: wait for more
            else:
                self._add(out, "<")
                self.buf = self.buf[1:]
        return out

    def _add(self, out, text):
        if self.part == "reply" and not self.reply_started:
            text = text.lstrip()
            if not text:
                return
            self.reply_started = True
        if not text:
            return
        if out and out[-1][0] == self.part:
            out[-1] = (self.part, out[-1][1] + text)
        else:
            out.append((self.part, text))


def apply(ctx, config):
    limit = int(config.get("max_data", 20000) or 0)
    started: dict[int, float] = {}

    def turn_of(g):
        h = g.get("self")
        return getattr(h, "current_turn", None) if h is not None else g.get("turn")

    def ident(g):
        a = g.get("args") or {}
        t, i = turn_of(g), a.get("_index", 0)
        return f"{t}.{i}", t, i

    def on_agent_before(g, nxt):
        ctx.emit("run.start", {})
        return nxt(g)

    def on_turn_before(g, nxt):
        ctx.emit("turn.start", {"turn": g.get("turn")})
        return nxt(g)

    def unwrap(client):
        d = getattr(client, "__dict__", None)
        if d is not None and getattr(d.get("chat"), "_ga_events_tap", False):
            del d["chat"]

    def on_llm_before(g, nxt):
        client, turn = g.get("client"), g.get("turn")
        orig = getattr(client, "chat", None)
        if callable(orig) and not getattr(orig, "_ga_events_tap", False):
            def chat(*a, **k):
                unwrap(client)              # one call only; later turns re-install
                gen = orig(*a, **k)
                if not hasattr(gen, "__next__"):
                    return gen
                return _tap(gen, turn)
            chat._ga_events_tap = True
            try:
                client.chat = chat
            except Exception:
                pass                        # e.g. __slots__: no deltas, assistant.text still works
        return nxt(g)

    def _tap(gen, turn):
        split = _Split()

        def emit(parts):
            for part, text in parts:
                ctx.emit("assistant.delta", {"turn": turn, "part": part, "text": text})
        try:
            while True:
                try:
                    chunk = next(gen)
                except StopIteration as e:
                    emit(split.flush())
                    return e.value
                if isinstance(chunk, str) and chunk:
                    emit(split.feed(chunk))
                yield chunk
        finally:
            gen.close()

    def on_llm_after(g, nxt):
        unwrap(g.get("client"))
        r = g.get("response")
        text = getattr(r, "content", None) or ""
        split = _Split()
        parts = {name: [] for name in ("summary", "thinking", "reply")}
        for part, chunk in split.feed(text) + split.flush():
            parts[part].append(chunk)
        fields = {part: "".join(chunks).strip() for part, chunks in parts.items()}
        ctx.emit("assistant.text", {
            "turn": g.get("turn"),
            "text": text,
            "reply": re.sub(r"\n{3,}", "\n\n", fields["reply"]),
            "thinking": getattr(r, "thinking", None) or fields["thinking"],
            "summary": fields["summary"],
        })
        return nxt(g)

    def on_tool_before(g, nxt):
        name = g.get("tool_name")
        if name and name != "no_tool":
            a = g.get("args") or {}
            started[id(a)] = time.perf_counter()
            tid, t, i = ident(g)
            ctx.emit("tool.call", {"id": tid, "turn": t, "index": i, "name": name,
                                   "args": _plain({k: v for k, v in a.items() if k not in _PRIVATE})})
        return nxt(g)

    def on_tool_after(g, nxt):
        name = g.get("tool_name")
        if name and name != "no_tool":
            a = g.get("args") or {}
            t0 = started.pop(id(a), None)
            ret = g.get("ret")
            data = getattr(ret, "data", ret)
            ok = not (isinstance(data, dict) and str(data.get("status", "")).lower() == "error")
            tid, t, i = ident(g)
            ctx.emit("tool.result", {"id": tid, "turn": t, "index": i, "name": name, "ok": ok,
                                     "data": _text(data, limit),
                                     "seconds": round(time.perf_counter() - t0, 3) if t0 else None})
        return nxt(g)

    def on_turn_after(g, nxt):
        ctx.emit("turn.end", {"turn": g.get("turn"), "exit": _plain(g.get("exit_reason") or {})})
        return nxt(g)

    def on_agent_after(g, nxt):
        started.clear()
        unwrap(g.get("client"))
        ctx.emit("run.end", {"exit": _plain(g.get("exit_reason") or {})})
        return nxt(g)

    for ev, fn in (("agent_before", on_agent_before), ("turn_before", on_turn_before),
                   ("llm_before", on_llm_before), ("llm_after", on_llm_after), ("tool_before", on_tool_before),
                   ("tool_after", on_tool_after), ("turn_after", on_turn_after),
                   ("agent_after", on_agent_after)):
        ctx.on("ga." + ev, fn)
