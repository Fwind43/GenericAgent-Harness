"""Event bus with dsh/Cordis-style dispatch modes.

emit      fire-and-forget notification, listener errors are logged not raised
serial    call listeners in order, return list of results
bail      return first non-None result
parallel  run listeners concurrently in threads, return list of results
waterfall middleware chain: listener(value, next) -> result; core fn is the innermost
"""
from __future__ import annotations
import itertools
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from .effect import Disposer

log = logging.getLogger("ga_harness.kernel")
_seq = itertools.count()


class EventBus:
    def __init__(self):
        self._listeners: dict[str, list[tuple[int, int, Callable]]] = {}

    def on(self, name: str, fn: Callable, priority: int = 0) -> Disposer:
        """Higher priority runs first (outermost for waterfall). Returns a disposer."""
        entry = (-priority, next(_seq), fn)
        lst = self._listeners.setdefault(name, [])
        lst.append(entry)
        lst.sort(key=lambda e: (e[0], e[1]))

        def off():
            try:
                self._listeners.get(name, []).remove(entry)
            except ValueError:
                pass
        return off

    def listeners(self, name: str) -> list[Callable]:
        return [e[2] for e in self._listeners.get(name, [])]

    def emit(self, name: str, *args, **kw) -> None:
        for fn in self.listeners(name):
            try:
                fn(*args, **kw)
            except Exception:
                log.exception("listener for %s failed", name)

    def serial(self, name: str, *args, **kw) -> list[Any]:
        return [fn(*args, **kw) for fn in self.listeners(name)]

    def bail(self, name: str, *args, **kw) -> Any:
        for fn in self.listeners(name):
            r = fn(*args, **kw)
            if r is not None:
                return r
        return None

    def parallel(self, name: str, *args, **kw) -> list[Any]:
        fns = self.listeners(name)
        if not fns:
            return []
        with ThreadPoolExecutor(max_workers=len(fns)) as ex:
            return [f.result() for f in [ex.submit(fn, *args, **kw) for fn in fns]]

    def waterfall(self, name: str, value: Any, core: Callable[[Any], Any] | None = None) -> Any:
        fns = self.listeners(name)
        core = core or (lambda v: v)

        def make(i: int) -> Callable[[Any], Any]:
            if i >= len(fns):
                return core
            nxt = make(i + 1)
            return lambda v: fns[i](v, nxt)
        return make(0)(value)
