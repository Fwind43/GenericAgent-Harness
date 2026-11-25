"""ga-steer: graceful (non-interrupting) injection of user messages into a run.

Runs inside the worker. The host pushes ``("steer", {"id", "text"})``; the text
is delivered at the next turn boundary instead of aborting the task:

* mid-task: appended to the next prompt by wrapping ``turn_end_callback``;
* task about to finish: GA's agent loop pops ``handler._done_hooks`` before it
  stops, so a pending steer is kept there as a single entry and continues the
  run with the user's message.

Delivered messages are also appended to ``handler.history_info`` (using GA's
``[USER]: ...`` format) right after the current turn's own summary is recorded,
so they survive raw message trimming in ``[WORKING MEMORY]`` and session save.

Events (``plugin.steer.applied`` / ``plugin.steer.unused``) report which ids were
delivered; ids still pending when the agent loop ends are reported as unused so
the host can requeue them.
"""
import threading

PREFIX = "[User message sent while you were working \u2014 take it into account and continue]\n"
HISTORY_MAX_LEN = 200
HISTORY_OMIT = " ... "


def _compose(items):
    # ``raw`` items come from host plugins (e.g. swarm board mentions) that carry
    # their own framing; only plain user messages get the generic prefix.
    user = [item["text"] for item in items if not item.get("raw")]
    parts = [PREFIX + "\n\n".join(user)] if user else []
    parts += [item["text"] for item in items if item.get("raw")]
    return "\n\n".join(parts)


def _history_entry(text):
    # Match GA's agentmain.py ``[USER]: <smart_format(..., 200)>`` convention so
    # ``_fold_earlier`` keeps steered messages instead of folding them away.
    flat = " ".join(text.splitlines()).strip()
    if len(flat) >= HISTORY_MAX_LEN + len(HISTORY_OMIT) * 2:
        half = HISTORY_MAX_LEN // 2
        flat = f"{flat[:half]}{HISTORY_OMIT}{flat[-half:]}"
    return f"[USER]: {flat}"


def _record_history(handler, items):
    history = getattr(handler, "history_info", None)
    if not isinstance(history, list) or not items:
        return
    for item in items:
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            history.append(_history_entry(text))


def apply(ctx, config):
    host = ctx.get("run.host") if ctx.has("run.host") else None
    lock = threading.Lock()
    state = {"handler": None, "items": [], "entry": None, "pending_history": []}

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

    def _take_applied(turn=None):
        items = state["items"]
        state["items"] = []
        if not items:
            return None
        state["pending_history"].extend(items)
        ids = [item["id"] for item in items]
        # ``turn`` is the GA turn whose end delivered the text; the note belongs after it.
        notes = [{"kind": "steer", "text": item["text"], **({"turn": turn} if isinstance(turn, int) else {})}
                 for item in items]
        # ``notes`` asks the host to show the delivered text in the transcript.
        return {"ids": ids, "notes": notes}

    def _flush_history(handler):
        with lock:
            items = state["pending_history"]
            state["pending_history"] = []
        _record_history(handler, items)

    def _sync():
        handler = state["handler"]
        if handler is None:
            return None
        applied = _take_applied() if _detach(handler) else None
        if state["items"] and isinstance(getattr(handler, "_done_hooks", None), list):
            state["entry"] = _compose(state["items"])
            handler._done_hooks.insert(0, state["entry"])
        return applied

    def on_steer(data):
        data = data or {}
        text = data.get("text")
        if not isinstance(text, str) or not text.strip():
            return
        with lock:
            # Detach before appending so an already-consumed _done_hooks entry
            # only marks the previously queued items as applied, not the new one.
            applied = _take_applied() if _detach(state["handler"]) else None
            state["items"].append({"id": data.get("id"), "text": text, "raw": bool(data.get("raw"))})
            extra = _sync()
        for payload in (applied, extra):
            if payload:
                emit("steer.applied", payload)

    if host is not None:
        ctx.scope.add(host.on_push("steer", on_steer))

    def before(gactx, nxt):
        handler = gactx.get("handler")
        if handler is not None and not getattr(handler, "_gah_steer", False):
            original = handler.turn_end_callback

            def turn_end(response, tool_calls, tool_results, turn, next_prompt, exit_reason):
                with lock:
                    if _detach(handler):
                        applied = _take_applied(turn)  # popped from _done_hooks: already in next_prompt
                    elif state["items"] and not exit_reason:
                        next_prompt = (next_prompt + "\n\n" if next_prompt else "") + _compose(state["items"])
                        applied = _take_applied(turn)
                    else:
                        applied = _sync()
                if applied:
                    emit("steer.applied", applied)
                try:
                    return original(response, tool_calls, tool_results, turn, next_prompt, exit_reason)
                finally:
                    # Append after GA's turn_end_callback writes [Agent] summary
                    # for ``turn`` so history_info stays in chronological order.
                    _flush_history(handler)

            handler.turn_end_callback = turn_end
            handler._gah_steer = True
        with lock:
            state["handler"] = handler
            applied = _sync()
        if applied:
            emit("steer.applied", applied)
        return nxt(gactx)

    def after(gactx, nxt):
        with lock:
            handler = state["handler"]
            applied = _take_applied() if _detach(handler) else None
            pending = state["pending_history"]
            state["pending_history"] = []
            ids = [item["id"] for item in state["items"]]
            texts = [item["text"] for item in state["items"]]
            state["items"] = []
            state["handler"] = None
        _record_history(handler, pending)
        if applied:
            emit("steer.applied", applied)
        if ids:
            emit("steer.unused", {"ids": ids, "texts": texts})
        return nxt(gactx)

    ctx.on("ga.agent_before", before)
    ctx.on("ga.agent_after", after)
