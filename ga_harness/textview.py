"""Plain-text rendering of ga-events for terminal frontends (ui-cli, ui-tui, ...).

Frontends must render from the structured ga-events (run/turn/assistant/tool), never by
regex-parsing ``agent.chunk``: that is GA's display text (``**LLM Running (Turn N) ...**``,
tool fences, ``[Stdout]`` ...), whose format belongs to GA and can change at any time.

``agent.chunk`` is only used as a fallback: when no structured event arrives during a run
(ga-events not mounted, or a non-GA agent) the raw chunks are passed through unchanged.
``raw=True`` always passes them through (debugging GA's own output).

Output, one block per step::

    -- step 1: <summary>
    <reply text, if any>
      > code_run  print(2**20)
        ok 1.0s
        | 1048576
      tokens in 1,110 (cache read 1,000 / write 100) out 42
    == tokens: 3 calls, in 1,660 (cache read 1,300 / write 100) out 54

``usage`` / ``usage.total`` (from the ga-usage plugin) are optional and never switch the
view into structured mode on their own.
"""
from __future__ import annotations
import json

STRUCTURED = ("run.start", "turn.start", "assistant.text", "tool.call", "tool.result", "turn.end", "run.end")
ARG_KEYS = ("script", "command", "code", "path", "pattern", "query", "url", "keyword", "text")
OUT_KEYS = ("stdout", "msg", "message", "content", "result", "error")


def usage_text(d) -> str:
    """``in 1,110 (cache read 1,000 / write 100) out 42`` for a usage / usage.total payload."""
    def n(k):
        v = d.get(k)
        return v if isinstance(v, int) else 0
    s = f"in {n('input'):,}"
    if n("cache_read") or n("cache_write"):
        s += f" (cache read {n('cache_read'):,} / write {n('cache_write'):,})"
    return s + f" out {n('output'):,}"


def one_line(s, width: int) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= width else s[: max(width - 3, 0)] + "..."


def arg_summary(args, width: int = 80) -> str:
    if not isinstance(args, dict):
        return one_line(args or "", width)
    for k in ARG_KEYS:
        v = args.get(k)
        if isinstance(v, str) and v.strip():
            return one_line(v, width)
    if not args:
        return ""
    return one_line(json.dumps(args, ensure_ascii=False, default=str), width)


def result_lines(data, lines: int = 3, width: int = 160) -> list[str]:
    """First ``lines`` lines of a tool result; dict results show their main text field."""
    if data is None or lines <= 0:
        return []
    v = data
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            pass
    if isinstance(v, dict):
        v = next((v[k] for k in OUT_KEYS if isinstance(v.get(k), str) and v[k].strip()),
                 json.dumps(v, ensure_ascii=False, default=str))
    elif not isinstance(v, str):
        v = json.dumps(v, ensure_ascii=False, default=str)
    rows = [r.rstrip() for r in str(v).replace("\r\n", "\n").split("\n")]
    while rows and not rows[-1]:
        rows.pop()
    out = [r if len(r) <= width else r[: width - 3] + "..." for r in rows[:lines]]
    if len(rows) > lines:
        out.append(f"... (+{len(rows) - lines} lines)")
    return out


class TextView:
    """Subscribe to ga-events on ``ctx.events`` and write a readable transcript."""

    def __init__(self, ctx, write, *, raw: bool = False, tool_lines: int = 3, width: int = 160,
                 show_log: bool = False):
        self.ctx = ctx
        self.write = write
        self.raw = raw
        self.tool_lines = tool_lines
        self.width = width
        self.show_log = show_log
        self.structured = False

    def attach(self):
        """Start listening; returns a disposer that removes every listener."""
        offs = [self.ctx.events.on("agent.chunk", self._chunk)]
        if self.show_log:
            offs.append(self.ctx.events.on("agent.log", self._log))
        if not self.raw:
            for name in STRUCTURED:
                offs.append(self.ctx.events.on(name, lambda d=None, _n=name: self._event(_n, d or {})))
            offs.append(self.ctx.events.on("usage", self._usage))
            offs.append(self.ctx.events.on("usage.total", self._usage_total))

        def off():
            for o in offs:
                o()
        return off

    def begin(self) -> None:
        """Call before each agent.run: re-decide structured vs raw for the new run."""
        self.structured = False

    def _log(self, d):
        text = (d or {}).get("text", "")
        if text.strip():
            self.write("  . " + text[: self.width] + "\n")

    def _usage(self, d):
        if self.structured and isinstance(d, dict):
            self.write("      tokens " + usage_text(d) + "\n")

    def _usage_total(self, d):
        if self.structured and isinstance(d, dict):
            calls = d.get("calls")
            self.write(f"    == tokens: {calls} call{'s' if calls != 1 else ''}, " + usage_text(d) + "\n")

    def _chunk(self, text):
        if self.raw or not self.structured:
            self.write(text)

    def _event(self, name, d):
        self.structured = True
        if name == "assistant.text":
            head = f"-- step {d.get('turn')}"
            if d.get("summary"):
                head += ": " + one_line(d["summary"], self.width)
            out = head + "\n"
            reply = (d.get("reply") or "").strip()
            if reply:
                out += reply + "\n"
            self.write(out)
        elif name == "tool.call":
            s = arg_summary(d.get("args"))
            self.write(f"  > {d.get('name')}" + (f"  {s}" if s else "") + "\n")
        elif name == "tool.result":
            sec = d.get("seconds")
            out = "    " + ("ok" if d.get("ok", True) else "FAILED") + (f" {sec:.1f}s" if isinstance(sec, (int, float)) else "") + "\n"
            for r in result_lines(d.get("data"), self.tool_lines, self.width):
                out += "    | " + r + "\n"
            self.write(out)
