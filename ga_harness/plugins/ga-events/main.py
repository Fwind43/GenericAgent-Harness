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
  llm.start       {turn, started}        one LLM call began; started = unix seconds (live timers)
  llm.timed       {turn, seconds, ttft}   one LLM call: wall time and time to first chunk (None if not streamed;
                  prefers llmcore's own first-SSE-line time for the last attempt, else first visible chunk)
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
  max_prompt  truncate each ``llm.prompt`` to this many chars (default 100000, 0 = no limit)

``llm.prompt`` reports what one LLM call actually sends: the argument GA passes to
``client.backend.ask`` (tapped once per call, like ``client.chat``). Text-protocol
clients send one string that already holds any system/tool injection; native clients
send one message, and the backend's system prompt and tool schemas are included
whenever they differ from the previous call in this worker (always on the first).
"""
from __future__ import annotations
import json
import re
import sys
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


def _core_ttft(w0):
    """TTFT as GA's llmcore measured it for the last attempt of this call.

    ``llmcore.STATS`` is process-global: ``t_start`` is reset before every
    attempt (so retries/backoff are excluded) and ``t_ttft`` is stamped on the
    first SSE line. Our own timer runs from llm_before to the first *visible*
    chunk, so it also counts request building, retries and hidden reasoning.
    None when missing, not streamed (t_ttft == t_start) or older than ``w0``.
    """
    stats = getattr(sys.modules.get("llmcore"), "STATS", None)
    if w0 is None or not isinstance(stats, dict):
        return None
    start, first = stats.get("t_start"), stats.get("t_ttft")
    if not all(isinstance(v, (int, float)) for v in (start, first)):
        return None
    if start < w0 or first <= start:
        return None
    return first - start


def _blocks(content):
    if isinstance(content, str):
        return content
    out = []
    for b in content if isinstance(content, list) else [content]:
        if not isinstance(b, dict):
            out.append(str(b))
            continue
        kind = b.get("type")
        if kind == "text":
            out.append(b.get("text") or "")
        elif kind == "tool_result":
            out.append(f"[tool_result {b.get('tool_use_id', '')}]\n{_blocks(b.get('content') or '')}")
        elif kind == "tool_use":
            out.append(f"[tool_use {b.get('name', '')}] {_text(b.get('input'), 0)}")
        elif kind in ("image", "image_url", "input_image"):
            out.append("[image]")
        else:
            out.append(_text(b, 0))
    return "\n\n".join(out)


_TEXT_TOOLS_MARK = "### Tools (mounted, always in effect):"


def _prompt(arg, backend, seen):
    """Render one backend.ask argument; ``seen`` keeps the last native system/tools."""
    if isinstance(arg, str):
        # GA's text protocol re-sends the full tool list under this fixed heading only
        # when it injects tools again; otherwise it sends a one-line reminder instead.
        return "text", arg, (["tools"] if _TEXT_TOOLS_MARK in arg else [])
    sections, injected = [], []
    if backend is not None:
        for key in ("system", "tools"):
            value = getattr(backend, key, None)
            if not value:
                continue
            body = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=1, default=str)
            if seen.get(key) != body:
                seen[key] = body
                injected.append(key)
                sections.append(f"### {key}\n{body}")
    if isinstance(arg, dict) and "content" in arg:
        sections.append(f"### {arg.get('role') or 'message'}\n{_blocks(arg.get('content'))}")
    elif isinstance(arg, list):
        for m in arg:
            if isinstance(m, dict):
                sections.append(f"### {m.get('role') or 'message'}\n{_blocks(m.get('content'))}")
            else:
                sections.append(_text(m, 0))
    else:
        sections.append(_text(arg, 0) or "")
    return "native", "\n\n".join(sections), injected


def apply(ctx, config):
    limit = int(config.get("max_data", 20000) or 0)
    prompt_limit = int(config.get("max_prompt", 100000) or 0)
    seen: dict = {}
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

    asks = {}  # id(backend) -> (backend, had_instance_attr, previous)

    def untap(client):
        backend = getattr(client, "backend", None)
        saved = asks.pop(id(backend), None)
        if saved is None:
            return
        d = getattr(backend, "__dict__", None)
        if d is not None and getattr(d.get("ask"), "_ga_events_tap", False):
            if saved[1]:
                d["ask"] = saved[2]
            else:
                del d["ask"]

    def tap_ask(client, turn):
        backend = getattr(client, "backend", None)
        orig = getattr(backend, "ask", None)
        d = getattr(backend, "__dict__", None)
        if d is None or not callable(orig) or getattr(orig, "_ga_events_tap", False):
            return

        def ask(*a, **k):
            untap(client)                   # one call only; retries are not repeated
            try:
                arg = a[0] if a else next(iter(k.values()), None)
                kind, text, injected = _prompt(arg, backend, seen)
                ctx.emit("llm.prompt", {"turn": turn, "kind": kind, "chars": len(text),
                                        "injected": injected, "text": _text(text, prompt_limit)})
            except Exception:
                pass                        # reporting must never break the call
            return orig(*a, **k)
        ask._ga_events_tap = True
        asks[id(backend)] = (backend, "ask" in d, d.get("ask"))
        try:
            backend.ask = ask
        except Exception:
            asks.pop(id(backend), None)

    # t0/first: our own timer (llm_before -> first visible chunk); w0: wall-clock
    # start, used to tell whether llmcore.STATS belongs to this call.
    llm = {"t0": None, "w0": None, "first": None}

    def on_llm_before(g, nxt):
        client, turn = g.get("client"), g.get("turn")
        llm.update(t0=time.monotonic(), w0=time.time(), first=None)
        ctx.emit("llm.start", {"turn": turn, "started": round(llm["w0"], 3)})
        tap_ask(client, turn)
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
                    if llm["first"] is None:
                        llm["first"] = time.monotonic()
                    emit(split.feed(chunk))
                yield chunk
        finally:
            gen.close()

    def on_llm_after(g, nxt):
        unwrap(g.get("client"))
        untap(g.get("client"))
        t0, w0, first = llm["t0"], llm["w0"], llm["first"]
        llm.update(t0=None, w0=None, first=None)
        if t0 is not None:
            now = time.monotonic()
            ttft = _core_ttft(w0)
            if ttft is not None and first is not None and ttft > first - t0 + 0.05:
                ttft = None  # impossible for this call: STATS was overwritten by another call
            if ttft is None and first is not None:
                ttft = first - t0
            ctx.emit("llm.timed", {"turn": g.get("turn"), "seconds": round(now - t0, 3),
                                   "ttft": None if ttft is None else round(ttft, 3)})
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
