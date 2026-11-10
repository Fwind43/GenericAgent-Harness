"""One isolated GA runtime per run. No host session database is opened here."""
from __future__ import annotations

import copy
import logging
import multiprocessing
import os
import threading
from pathlib import Path
from types import SimpleNamespace

from . import model_keys

EMPTY_REPLY = "The model returned an empty response; the run stopped. Send a message to continue."
EVENTS = ("assistant.delta", "assistant.text", "tool.call", "tool.result", "turn.start", "turn.end",
          "usage", "usage.total", "llm.start", "llm.timed", "llm.prompt")
# Host/UI/storage plugins must never be mounted in a worker. DEFAULT_PLUGINS are
# the runtime infrastructure every run needs; they follow the host (mounted with
# the host config while active there). Everything the agent can do beyond that,
# tools and prompt additions alike, comes from the run's mode: an agent preset
# lists its plugins (``plugins``), and the Standard mode is the built-in
# ``standard`` preset (``plugins = ["*"]``: whatever the host has enabled).
# Further execution plugins come from run-store.worker_plugins or
# Runs.register_worker_plugin.
DEFAULT_PLUGINS = frozenset(("ga-hooks", "ga-stdout", "ga-timing",
                             "ga-events", "ga-usage", "ga-file-changes", "ga-core", "ga-prompt",
                             "ga-tools"))
# A mode listing HOST_PLUGINS ("*") also gets every agent plugin enabled in the
# host at run start (live: toggling a plugin affects the next run). That is how the
# Standard mode works.
HOST_PLUGINS = "*"
HOST_ONLY = frozenset(("frontend", "web.host", "sessions", "runs", "workspaces", "models"))


def host_only(manifest):
    return bool(set(manifest.provides) & HOST_ONLY
                or "web.host" in {key.rstrip("?") for key in manifest.inject})


def host_agent_plugins(ctx, manifests):
    """Names of plugins active in the host right now that can run inside a worker.

    Host-only plugins (UI, storage, services) are excluded, and so is any plugin
    whose required capabilities a worker cannot provide (e.g. ``runs``,
    ``plugin.catalog``, ``channel_manager``); what remains are agent extensions
    such as tools, prompt additions and hooks.
    """
    active = {name for name, handle in ctx.runtime.handles.items()
              if handle.state == "active" and name in manifests}
    caps = set()
    for name in DEFAULT_PLUGINS & active:
        caps.update(manifests[name].provides)
    pending = {name for name in active - DEFAULT_PLUGINS
               if not host_only(manifests[name]) and not getattr(manifests[name], "worker_only", False)}
    chosen = set()
    while True:
        ready = {name for name in pending
                 if {k for k in manifests[name].inject if not k.endswith("?")} <= caps}
        if not ready:
            return chosen
        chosen |= ready
        pending -= ready
        for name in ready:
            caps.update(manifests[name].provides)


def recipe_for(ctx, extra=(), mode=()):
    """Plugins for one run: infrastructure, the mode's plugins and ``extra``.

    ``HOST_PLUGINS`` in ``mode`` expands to ``host_agent_plugins`` at call time.

    A mode plugin that also runs in the host follows the host: it is mounted
    with the host config while active there and skipped when the user disabled
    it. A ``worker_only`` mode plugin has no host state and is mounted from the
    catalog with its default config.
    """
    catalog = ctx.get("plugin.catalog")
    if catalog is None:
        raise RuntimeError("run-store requires the plugin catalog")
    manifests = catalog["preferences"].manifests
    mode = set(mode)
    if HOST_PLUGINS in mode:
        mode = (mode - {HOST_PLUGINS}) | host_agent_plugins(ctx, manifests)
    wanted = DEFAULT_PLUGINS | mode | set(extra)
    recipe = []

    def add(manifest, config):
        if host_only(manifest):
            raise ValueError(f"host plugin {manifest.name!r} cannot run in a worker")
        recipe.append((manifest, config))

    for name, handle in ctx.runtime.handles.items():
        if name not in wanted or handle.state != "active":
            continue
        add(manifests[name], copy.deepcopy(handle.config))
    if not any(manifest.name == "ga-core" for manifest, _ in recipe):
        raise RuntimeError("ga-core must be active before run-store")
    # Worker-only plugins requested by a host plugin (run-store.worker_plugins or
    # Runs.register_worker_plugin) need not be active in the host: they only make
    # sense inside a run. Mount them from the catalog with their default config.
    present = {manifest.name for manifest, _ in recipe}
    missing = []
    for name in sorted(set(extra) - present):
        if name in manifests:
            add(manifests[name], {})
        else:
            missing.append(name)
    for name in sorted(mode - present - set(extra)):
        if name not in manifests:
            missing.append(name)
        elif getattr(manifests[name], "worker_only", False):
            add(manifests[name], {})
    if missing:
        raise ValueError("worker plugins are not installed: " + ", ".join(missing))
    return recipe


class RpcError(RuntimeError):
    """A host RPC failed, was refused, timed out or the run was cancelled."""


class WorkerHost:
    """The ``run.host`` capability: a worker plugin's channel to the host process.

    ``call(service, body, timeout)`` blocks until the host's registered RPC
    handler answers (see ``Runs.register_rpc``); ``emit(name, data)`` sends a
    durable ``plugin.*`` run event to host subscribers; ``on_push(topic, fn)``
    receives ``Runs.push`` messages. Push listeners run on one dispatch thread.
    """

    def __init__(self, send, run_id, session_id):
        import queue
        self._send, self.run_id, self.session_id = send, run_id, session_id
        self.cancelled = threading.Event()
        self._pending, self._listeners, self._lock = {}, {}, threading.Lock()
        self._queue = queue.Queue()
        threading.Thread(target=self._dispatch, name="run-host-push", daemon=True).start()

    def call(self, service, body=None, timeout=60.0):
        import uuid
        if not isinstance(service, str) or not service:
            raise ValueError("rpc service name is required")
        if self.cancelled.is_set():
            raise RpcError("run was cancelled")
        rid = uuid.uuid4().hex
        slot = {"event": threading.Event(), "reply": None}
        with self._lock:
            self._pending[rid] = slot
        try:
            self._send("rpc", id=rid, service=service, body=body)
            if not slot["event"].wait(timeout):
                raise RpcError(f"host did not answer {service!r} within {timeout}s")
        except (OSError, ValueError, EOFError) as exc:
            raise RpcError(f"host unreachable ({type(exc).__name__})") from None
        finally:
            with self._lock:
                self._pending.pop(rid, None)
        reply = slot["reply"]
        if reply is None:
            raise RpcError("run was cancelled")
        if reply.get("error"):
            raise RpcError(reply["error"])
        return reply.get("result")

    def emit(self, name, data=None):
        if not isinstance(name, str) or not name:
            raise ValueError("event name is required")
        if not name.startswith("plugin."):
            name = "plugin." + name
        self._send("event", name=name, data=data)

    def on_push(self, topic, listener):
        if not callable(listener):
            raise TypeError("push listener must be callable")
        with self._lock:
            self._listeners.setdefault(topic, []).append(listener)

        def dispose():
            with self._lock:
                items = self._listeners.get(topic, [])
                if listener in items:
                    items.remove(listener)
        return dispose

    # -- called by the worker control thread -------------------------------------
    def _resolve(self, packet):
        with self._lock:
            slot = self._pending.get(packet.get("id"))
        if slot is not None:
            slot["reply"] = packet
            slot["event"].set()

    def _push(self, packet):
        self._queue.put((packet.get("topic"), packet.get("data")))

    def _dispatch(self):
        while True:
            topic, data = self._queue.get()
            if topic is None:
                return
            with self._lock:
                # Topic listeners get ``(data)``; ``"*"`` listeners get ``(topic, data)``.
                calls = [(fn, (data,)) for fn in self._listeners.get(topic, ())]
                calls += [(fn, (topic, data)) for fn in self._listeners.get("*", ())]
            for listener, args in calls:
                try:
                    listener(*args)
                except Exception:
                    logging.getLogger("gah.worker").exception("listener for %s failed", topic)

    def _close(self):
        self.cancelled.set()
        with self._lock:
            slots = list(self._pending.values())
        for slot in slots:
            slot["event"].set()
        self._queue.put((None, None))


def run_worker(connection, recipe, payload):
    # Importing/mounting GA only happens after spawn, never in the host's thread.
    from . import logfile
    if threading.current_thread() is threading.main_thread() and multiprocessing.parent_process() is not None:
        logfile.setup("worker")  # only in a real spawned worker, not when tests call it inline
    logging.getLogger("gah.worker").info("run %s start session=%s", payload.get("run_id"), payload.get("session_id"))
    from .kernel import Runtime
    from .sessions import apply_effort, capture, restore
    from .workspaces import Workspaces

    runtime = Runtime()
    send_lock = threading.Lock()
    started = False

    def send(kind, **data):
        with send_lock:
            connection.send(dict(kind=kind, **data))

    try:
        workspace = payload["scope"]["workspace"]
        if not Path(workspace).is_dir():
            raise ValueError("workspace is no longer available")
        os.chdir(workspace)
        runtime.ctx.provide("run.context", {**{key: payload[key] for key in ("session_id", "run_id")},
                                            "workspace": str(workspace)})
        # Provided before any plugin mounts so worker plugins can inject it.
        host = WorkerHost(send, payload["run_id"], payload["session_id"])
        runtime.ctx.provide("run.host", host)
        for manifest, config in recipe:
            runtime.add(manifest.to_plugin(), config)
        failed = [name for name, status in runtime.status().items() if status["state"] != "active"]
        if failed:
            raise RuntimeError("worker plugins failed to activate: " + ", ".join(failed))
        agent = runtime.ctx.get("agent")
        raw = runtime.ctx.get("ga.agent")
        state = payload["state"]
        if state.get("model_key") or state.get("model"):
            hit = model_keys.find(raw.llmclients, state.get("model_key"), state.get("model"))
            if hit is None:
                raise ValueError("the session's model is no longer configured")
            raw.llmclient = hit[1]
        restore(raw, state)
        apply_effort(raw)
        # Reuse exactly the same workspace and project prompt hooks as single-agent
        # execution, with an immutable scope and no dependency on host selection.
        binding = SimpleNamespace(sessions=SimpleNamespace(agent=raw), active=payload["scope"])
        Workspaces.ga_project(raw, payload["scope"])
        runtime.ctx.on("ga.agent_before", lambda g, nxt: Workspaces.bind(binding, g, nxt))
        runtime.ctx.on("ga.llm_before", lambda g, nxt: Workspaces.inject(binding, g, nxt))
        runtime.ctx.on("agent.chunk", lambda text: send("event", name="agent.chunk", data=text))

        # GA ends a run "normally" after an empty model reply in some setups;
        # remember whether the final LLM call produced neither text nor tools.
        last = {"empty": False}

        def track_reply(g, nxt):
            r = g.get("response")
            last["empty"] = r is not None and not str(getattr(r, "content", "") or "").strip() \
                and not getattr(r, "tool_calls", None)
            return nxt(g)
        runtime.ctx.on("ga.llm_after", track_reply)
        for name in EVENTS:
            runtime.ctx.on(name, lambda data, event=name: send("event", name=event, data=data))

        def control():
            try:
                while True:
                    packet = connection.recv()
                    kind = packet.get("kind")
                    if kind == "cancel":
                        break
                    if kind in ("rpc_result", "plugin_result"):
                        host._resolve(packet)
                    elif kind == "push":
                        host._push(packet)
            except (EOFError, OSError):
                pass
            host._close()
            agent.abort()

        threading.Thread(target=control, name="run-control", daemon=True).start()
        # Snapshot the worker's actual selection after restore/apply_effort, not
        # the host's currently selected session or its model defaults.
        backend = getattr(getattr(raw, "llmclient", None), "backend", None)
        model = getattr(backend, "model", "") or getattr(backend, "name", "") or ""
        effort = getattr(backend, "reasoning_effort", None)
        send("event", name="assistant.metadata", data={
            "model": model if isinstance(model, str) else "",
            "reasoning_effort": effort if isinstance(effort, str) else None,
        })
        send("ready")
        started = True
        result = agent.run(payload["task"], source=payload.get("source", "user"),
                           images=payload.get("images") or None, timeout=payload.get("timeout"))
        if last["empty"]:
            logging.getLogger("gah.worker").warning("run %s ended after an empty model reply", payload.get("run_id"))
            send("error", error=EMPTY_REPLY, state=capture(raw))
        else:
            send("done", text=str(result or ""), state=capture(raw))
    except Exception as error:
        # Once the agent has run, its history already contains this partial turn.
        # Return it so continuing the session matches the visible output. Setup
        # failures keep the host's prior state rather than an empty runtime.
        state = None
        if started:
            try:
                state = capture(raw)
            except Exception:
                state = None
        # Tracebacks/config values can contain credentials; persist only the class.
        send("error", error=f"Worker failed ({type(error).__name__})", state=state)
    finally:
        runtime.dispose()
        connection.close()
