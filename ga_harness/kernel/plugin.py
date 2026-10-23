"""Plugin lifecycle: a plugin activates once every injected capability exists,
and is suspended (scope disposed) when one of them is withdrawn. It comes back
automatically when the capability is provided again.

inject entries ending with "?" are optional (do not gate activation).
"""
from __future__ import annotations
import logging
from dataclasses import dataclass, field
from typing import Any, Callable

from .context import Context, Root
from .effect import Disposer, Scope

log = logging.getLogger("ga_harness.kernel")


@dataclass
class Plugin:
    name: str
    apply: Callable[[Context, Any], Any]
    inject: list[str] = field(default_factory=list)
    provides: list[str] = field(default_factory=list)

    @property
    def required(self) -> list[str]:
        return [k for k in self.inject if not k.endswith("?")]


@dataclass
class Handle:
    plugin: Plugin
    config: Any
    state: str = "pending"          # pending | active | error | removed
    ctx: Context | None = None
    error: BaseException | None = None


class Runtime:
    def __init__(self, root_ctx: Context | None = None):
        self.ctx = root_ctx or Context(Root(), Scope("root"), "root")
        self.ctx._root.runtime = self
        self.handles: dict[str, Handle] = {}
        self._busy = False

    # ---- public -------------------------------------------------------
    def add(self, plugin: Plugin, config: Any = None) -> Disposer:
        if plugin.name in self.handles:
            raise KeyError(f"plugin {plugin.name!r} already loaded")
        h = Handle(plugin, config if config is not None else {})
        self.handles[plugin.name] = h
        self._reconcile()

        def remove():
            if self.handles.get(plugin.name) is h:
                self._deactivate(h)
                h.state = "removed"
                del self.handles[plugin.name]
        return remove

    def remove(self, name: str) -> None:
        h = self.handles.get(name)
        if h:
            self._deactivate(h)
            h.state = "removed"
            del self.handles[name]

    def reload(self, name: str, plugin: Plugin | None = None, config: Any = None) -> None:
        old = self.handles[name]
        self.remove(name)
        self.add(plugin or old.plugin, old.config if config is None else config)

    def status(self) -> dict[str, dict]:
        return {n: {"state": h.state,
                    "missing": [k for k in h.plugin.required if not self.ctx.has(k)],
                    "error": repr(h.error) if h.error else None}
                for n, h in self.handles.items()}

    def dispose(self) -> None:
        for h in reversed(list(self.handles.values())):
            self._deactivate(h)
        self.handles.clear()
        self.ctx.scope.dispose()

    # ---- internals ----------------------------------------------------
    def _ready(self, h: Handle) -> bool:
        return all(self.ctx.has(k) for k in h.plugin.required)

    def _activate(self, h: Handle) -> None:
        ctx = Context(self.ctx._root, Scope(h.plugin.name), h.plugin.name, h.config)
        h.ctx, h.state, h.error = ctx, "active", None
        try:
            ret = h.plugin.apply(ctx, h.config)
            if callable(ret):
                ctx.scope.add(ret)
        except Exception as e:
            log.exception("plugin %s failed to apply", h.plugin.name)
            h.error = e
            ctx.scope.dispose()
            h.state, h.ctx = "error", None

    def _deactivate(self, h: Handle) -> None:
        if h.state == "active" and h.ctx is not None:
            ctx, h.ctx = h.ctx, None
            h.state = "pending"
            ctx.scope.dispose()

    def _reconcile(self) -> None:
        if self._busy:
            return
        self._busy = True
        try:
            changed = True
            while changed:
                changed = False
                for h in list(self.handles.values()):
                    if h.state == "pending" and self._ready(h):
                        self._activate(h)
                        changed = True
        finally:
            self._busy = False

    def _on_withdraw(self, key: str) -> None:
        for h in list(self.handles.values()):
            if h.state == "active" and key in h.plugin.required:
                self._deactivate(h)
