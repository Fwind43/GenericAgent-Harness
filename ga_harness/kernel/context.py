"""Context: capability container + plugin-scoped registration helpers.

Every plugin receives its own child Context. Registrations made through it
(on / provide / effect) are owned by the plugin's Scope and undone on unload.
Capabilities are looked up by key: ``ctx.tools``, ``ctx.llm`` ...
"""
from __future__ import annotations
from typing import Any, Callable, TYPE_CHECKING

from .effect import Disposer, Scope
from .events import EventBus

if TYPE_CHECKING:
    from .plugin import Runtime

_OWN = {"_root", "scope", "name", "config"}


class Root:
    def __init__(self):
        self.services: dict[str, Any] = {}
        self.owners: dict[str, str] = {}
        self.events = EventBus()
        self.runtime: "Runtime | None" = None


class Context:
    def __init__(self, root: Root | None = None, scope: Scope | None = None,
                 name: str = "root", config: Any = None):
        object.__setattr__(self, "_root", root or Root())
        object.__setattr__(self, "scope", scope or Scope(name))
        object.__setattr__(self, "name", name)
        object.__setattr__(self, "config", config if config is not None else {})

    # ---- capabilities -------------------------------------------------
    def provide(self, key: str, impl: Any) -> Disposer:
        root = self._root
        if key in root.services:
            raise KeyError(f"capability {key!r} already provided by {root.owners.get(key)!r}")
        root.services[key] = impl
        root.owners[key] = self.name

        def withdraw():
            if root.services.get(key) is impl:
                del root.services[key]
                root.owners.pop(key, None)
                if root.runtime:
                    root.runtime._on_withdraw(key)
        d = self.scope.add(withdraw)
        if root.runtime:
            root.runtime._reconcile()
        return d

    def has(self, key: str) -> bool:
        return key in self._root.services

    def get(self, key: str, default: Any = None) -> Any:
        return self._root.services.get(key, default)

    def __getattr__(self, key: str) -> Any:
        try:
            return self._root.services[key]
        except KeyError:
            raise AttributeError(f"capability {key!r} is not available") from None

    def __setattr__(self, key, value):
        raise AttributeError("use ctx.provide(key, impl) to expose a capability")

    # ---- events -------------------------------------------------------
    @property
    def events(self) -> EventBus:
        return self._root.events

    def on(self, name: str, fn: Callable, priority: int = 0) -> Disposer:
        return self.scope.add(self._root.events.on(name, fn, priority))

    def emit(self, name, *a, **kw):
        return self._root.events.emit(name, *a, **kw)

    def serial(self, name, *a, **kw):
        return self._root.events.serial(name, *a, **kw)

    def bail(self, name, *a, **kw):
        return self._root.events.bail(name, *a, **kw)

    def parallel(self, name, *a, **kw):
        return self._root.events.parallel(name, *a, **kw)

    def waterfall(self, name, value, core=None):
        return self._root.events.waterfall(name, value, core)

    # ---- effects ------------------------------------------------------
    def effect(self, fn: Callable[[], Disposer | None]) -> Disposer:
        """Run fn now; the disposer it returns is owned by this context's scope."""
        return self.scope.add(fn())

    def child(self, name: str, config: Any = None) -> "Context":
        sub = Scope(name)
        c = Context(self._root, sub, name, config)
        self.scope.add(sub.dispose)
        return c

    @property
    def runtime(self) -> "Runtime":
        return self._root.runtime
