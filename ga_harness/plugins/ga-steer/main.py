"""ga-steer: graceful (non-interrupting) injection of user messages into a run.

Runs inside the worker. The host pushes ``("steer", {"id", "text"})``; the text
is delivered at the next turn boundary instead of aborting the task:

* mid-task: appended to the next prompt by wrapping ``turn_end_callback``;
* task about to finish: GA's agent loop pops ``handler._done_hooks`` before it
  stops, so a pending steer is kept there as a single entry and continues the
  run with the user's message.

Events (``plugin.steer.applied`` / ``plugin.steer.unused``) report which ids were
delivered; ids still pending when the agent loop ends are reported as unused so
the host can requeue them.
"""
import threading

PREFIX = "[User message sent while you were working \u2014 take it into account and continue]\n"


def _compose(items):
    return PREFIX + "\n\n".join(item["text"] for item in items)


def apply(ctx, config):
    host = ctx.get("run.host") if ctx.has("run.host") else None
    lock = threading.Lock()
    state = {"handler": None, "items": [], "entry": None}

    def emit(name, data):
        if host is not None:
            try:
                host.emit(name, data)
            except Exception:
                pass

    def _detach(handler):
        entry = state["entry"]
        state["entry"] = None
        if entry is None or handler is None:
            return False
        hooks = getattr(handler, "_done_hooks", None)
        for index, value in enumerate(hooks or []):
            if value is entry:
                del hooks[index]
                return False
        return True  # GA already consumed it as the continuation prompt

    def _sync():
        handler = state["handler"]
        if handler is None:
            return
        if _detach(handler):
            _applied()
        if state["items"] and isinstance(getattr(handler, "_done_hooks", None), list):
            state["entry"] = _compose(state["items"])
            handler._done_hooks.insert(0, state["entry"])

    def _applied():
        ids = [item["id"] for item in state["items"]]
        state["items"] = []
        if ids:
            emit("steer.applied", {"ids": ids})

    def on_steer(data):
        data = data or {}
        text = data.get("text")
        if not isinstance(text, str) or not text.strip():
            return
        with lock:
            state["items"].append({"id": data.get("id"), "text": text})
            _sync()

    if host is not None:
        ctx.scope.add(host.on_push("steer", on_steer))

    def before(gactx, nxt):
        handler = gactx.get("handler")
        if handler is not None and not getattr(handler, "_gah_steer", False):
            original = handler.turn_end_callback

            def turn_end(response, tool_calls, tool_results, turn, next_prompt, exit_reason):
                with lock:
                    if _detach(handler):
                        _applied()  # popped from _done_hooks: already in next_prompt
                    elif state["items"] and not exit_reason:
                        next_prompt = (next_prompt + "\n\n" if next_prompt else "") + _compose(state["items"])
                        _applied()
                    else:
                        _sync()
                return original(response, tool_calls, tool_results, turn, next_prompt, exit_reason)

            handler.turn_end_callback = turn_end
            handler._gah_steer = True
        with lock:
            state["handler"] = handler
            _sync()
        return nxt(gactx)

    def after(gactx, nxt):
        with lock:
            if _detach(state["handler"]):
                _applied()
            ids = [item["id"] for item in state["items"]]
            texts = [item["text"] for item in state["items"]]
            state["items"] = []
            state["handler"] = None
        if ids:
            emit("steer.unused", {"ids": ids, "texts": texts})
        return nxt(gactx)

    ctx.on("ga.agent_before", before)
    ctx.on("ga.agent_after", after)
