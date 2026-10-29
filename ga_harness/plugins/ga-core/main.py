"""ga-core: run GA's own GenericAgent unmodified inside the harness.

config:
  ga_root   path of the GenericAgent checkout (default: $GA_ROOT)
  module    module that defines GenericAgent (default: "agentmain"; tests swap it)
  inc_out   stream deltas instead of cumulative text (default: true)

Provides
  ga.agent  the raw GenericAgent instance (escape hatch for compat plugins)
  agent     AgentHandle: run(query) -> final text, abort()
Events (emit): agent.chunk(text), agent.done(text, item)
  agent.chunk is GA's raw display text ("**LLM Running (Turn N) ...**", tool fences,
  [Stdout] ...). Its format belongs to GA and is NOT a contract: frontends render from the
  ga-events events (run/turn/assistant/tool) and must not regex-parse chunks. Use chunks
  only as a fallback when no ga-events arrive, or for raw/debug output.
"""
from __future__ import annotations
import importlib
import os
import queue
import sys
import threading

_STOP = "__ga_harness_stop__"   # GA's run() exits on any str task
NO_MODEL = "No model is configured yet. Add one in Settings > Models."


class AgentHandle:
    def __init__(self, agent, ctx):
        self.raw = agent
        self._ctx = ctx

    def run(self, query: str, source: str = "user", images=None, timeout: float | None = None) -> str:
        return self._ctx.waterfall("agent.request",
            {"query": query, "source": source, "images": images, "timeout": timeout},
            lambda request: self._run(**request))

    def _run(self, query, source, images, timeout):
        if not getattr(self.raw, "llmclients", None):
            reload = getattr(self.raw, "load_llm_sessions", None)
            if callable(reload):
                try:
                    reload()   # mykey.py may have been edited since startup
                except Exception:
                    pass
        if not getattr(self.raw, "llmclients", None):
            raise RuntimeError(NO_MODEL)
        # GA's run loop drops task["images"]; deliver them on the first LLM call instead.
        restore = _inject_images(getattr(self.raw, "llmclient", None), images) if images else None
        try:
            return self._stream(query, source, images, timeout)
        finally:
            if restore:
                restore()

    def _stream(self, query, source, images, timeout):
        dq = self.raw.put_task(query, source=source, images=images)
        printed = ""
        while True:
            try:
                item = dq.get(timeout=timeout)
            except queue.Empty:
                self.abort()
                raise TimeoutError(f"no output within {timeout}s")
            if "next" in item:
                text = item["next"]
                if not getattr(self.raw, "inc_out", False):   # cumulative -> delta
                    text, printed = text[len(printed):], text
                if text:
                    self._ctx.emit("agent.chunk", text)
            if "done" in item:
                # done precedes GA history assignment and task_done.
                self.raw.task_queue.join()
                self._ctx.emit("agent.done", item["done"], item)
                return item["done"]

    def abort(self) -> None:
        self.raw.abort()


VISION_MIMES = {"image/png", "image/jpeg", "image/gif", "image/webp"}


def image_blocks(paths) -> list[dict]:
    """Anthropic-style base64 image blocks; llmcore converts them for OpenAI/Responses."""
    import base64
    import mimetypes
    blocks = []
    for p in paths or ():
        mime = mimetypes.guess_type(str(p))[0] or "image/png"
        if mime not in VISION_MIMES:
            continue
        try:
            with open(p, "rb") as f:
                data = base64.b64encode(f.read()).decode("ascii")
        except OSError:
            continue
        blocks.append({"type": "image", "source": {"type": "base64", "media_type": mime, "data": data}})
    return blocks


def _inject_images(client, paths):
    """One-shot wrap of the native backend's ask() that appends the images to the
    first user message (mirrors GA's desktop bridge). Returns an undo callable."""
    backend = getattr(client, "backend", None)
    original = getattr(backend, "ask", None)
    if not callable(original):
        return None
    blocks = image_blocks(paths)
    if not blocks:
        return None
    had_own = "ask" in vars(backend)

    def undo():
        if vars(backend).get("ask") is patched:
            if had_own:
                backend.ask = original
            else:
                del backend.ask

    def patched(msg, *args, **kwargs):
        undo()
        if isinstance(msg, dict) and isinstance(msg.get("content"), list):
            msg["content"].extend(blocks)
        return (yield from original(msg, *args, **kwargs))

    backend.ask = patched
    return undo


def load_module(ga_root: str | None, module: str):
    if ga_root:
        ga_root = os.path.abspath(ga_root)
        if ga_root not in sys.path:
            sys.path.insert(0, ga_root)
    return importlib.import_module(module)


def apply(ctx, config):
    mod = load_module(config.get("ga_root") or os.environ.get("GA_ROOT"), config.get("module", "agentmain"))
    agent = mod.GenericAgent()
    if not getattr(agent, "llmclients", None):
        # First run (e.g. the desktop's bundled GA ships an empty mykey.py): start anyway
        # so Settings > Models can add one; tasks are refused until a model exists.
        print("[ga-core] no model configured yet; add one in Settings > Models", file=sys.stderr)
    agent.inc_out = bool(config.get("inc_out", True))
    t = threading.Thread(target=agent.run, name="ga-core", daemon=True)
    t.start()

    def stop():
        agent.abort()
        agent.task_queue.put(_STOP)
        t.join(timeout=5)
    ctx.scope.add(stop)
    ctx.provide("ga.agent", agent)
    ctx.provide("agent", AgentHandle(agent, ctx))
