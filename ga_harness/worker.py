"""One isolated GA runtime per run. No host session database is opened here."""
from __future__ import annotations

import copy
import os
import threading
from pathlib import Path
from types import SimpleNamespace

EVENTS = ("assistant.text", "tool.call", "tool.result", "turn.start", "turn.end",
          "usage", "usage.total", "llm.timed")
# Host/UI/storage plugins must never be mounted in a worker. Additional execution
# plugins require explicit run-store.worker_plugins configuration.
DEFAULT_PLUGINS = frozenset(("llm-config", "ga-hooks", "ga-stdout", "ga-timing",
                             "ga-events", "ga-usage", "ga-core", "ga-prompt", "ga-tools"))


def recipe_for(ctx, extra=()):
    catalog = ctx.get("plugin.catalog")
    if catalog is None:
        raise RuntimeError("run-store requires the plugin catalog")
    wanted = DEFAULT_PLUGINS | set(extra)
    recipe = []
    for name, handle in ctx.runtime.handles.items():
        if name not in wanted or handle.state != "active":
            continue
        manifest = catalog["preferences"].manifests[name]
        if (set(manifest.provides) & {"frontend", "web.host", "sessions", "runs", "workspaces", "models"}
                or "web.host" in {key.rstrip("?") for key in manifest.inject}):
            raise ValueError(f"host plugin {name!r} cannot run in a worker")
        recipe.append((manifest, copy.deepcopy(handle.config)))
    if not any(manifest.name == "ga-core" for manifest, _ in recipe):
        raise RuntimeError("ga-core must be active before run-store")
    missing = set(extra) - {manifest.name for manifest, _ in recipe}
    if missing:
        raise ValueError("worker plugins are not active: " + ", ".join(sorted(missing)))
    return recipe


def run_worker(connection, recipe, payload):
    # Importing/mounting GA only happens after spawn, never in the host's thread.
    from .kernel import Runtime
    from .sessions import apply_effort, capture, restore
    from .workspaces import Workspaces

    runtime = Runtime()
    send_lock = threading.Lock()

    def send(kind, **data):
        with send_lock:
            connection.send(dict(kind=kind, **data))

    try:
        workspace = payload["scope"]["workspace"]
        if not Path(workspace).is_dir():
            raise ValueError("workspace is no longer available")
        os.chdir(workspace)
        runtime.ctx.provide("run.context", {key: payload[key] for key in ("session_id", "run_id")})
        for manifest, config in recipe:
            runtime.add(manifest.to_plugin(), config)
        failed = [name for name, status in runtime.status().items() if status["state"] != "active"]
        if failed:
            raise RuntimeError("worker plugins failed to activate: " + ", ".join(failed))
        agent = runtime.ctx.get("agent")
        raw = runtime.ctx.get("ga.agent")
        state = payload["state"]
        model = state.get("model")
        if model:
            client = next((c for c in raw.llmclients if getattr(c.backend, "name", None) == model), None)
            if client is None:
                raise ValueError("the session's model is no longer configured")
            raw.llmclient = client
        restore(raw, state)
        apply_effort(raw)
        # Reuse exactly the same workspace and project prompt hooks as single-agent
        # execution, with an immutable scope and no dependency on host selection.
        binding = SimpleNamespace(sessions=SimpleNamespace(agent=raw), active=payload["scope"])
        runtime.ctx.on("ga.agent_before", lambda g, nxt: Workspaces.bind(binding, g, nxt))
        runtime.ctx.on("ga.llm_before", lambda g, nxt: Workspaces.inject(binding, g, nxt))
        runtime.ctx.on("agent.chunk", lambda text: send("event", name="agent.chunk", data=text))
        for name in EVENTS:
            runtime.ctx.on(name, lambda data, event=name: send("event", name=event, data=data))

        def control():
            try:
                while connection.recv().get("kind") != "cancel":
                    pass
            except (EOFError, OSError):
                pass
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
        result = agent.run(payload["task"], source=payload.get("source", "user"), timeout=payload.get("timeout"))
        send("done", text=str(result or ""), state=capture(raw))
    except Exception as error:
        # Tracebacks/config values can contain credentials; persist only the class.
        send("error", error=f"Worker failed ({type(error).__name__})")
    finally:
        runtime.dispose()
        connection.close()
