"""Effect: every registration returns a disposer; scopes dispose in reverse order."""
from __future__ import annotations
import logging
from typing import Callable

log = logging.getLogger("ga_harness.kernel")
Disposer = Callable[[], None]


class Scope:
    """Owns disposers. Disposing runs them in reverse registration order, once."""

    def __init__(self, name: str = "scope"):
        self.name = name
        self._disposers: list[Disposer] = []
        self.disposed = False

    def add(self, disposer: Disposer | None) -> Disposer:
        if disposer is None:
            return lambda: None
        if self.disposed:
            raise RuntimeError(f"scope {self.name!r} already disposed")
        done = [False]

        def once():
            if done[0]:
                return
            done[0] = True
            if once in self._disposers:
                self._disposers.remove(once)
            disposer()

        self._disposers.append(once)
        return once

    def dispose(self) -> list[BaseException]:
        errors: list[BaseException] = []
        while self._disposers:
            fn = self._disposers[-1]
            try:
                fn()
            except BaseException as e:  # keep tearing down
                log.exception("dispose failed in %s", self.name)
                errors.append(e)
                if self._disposers and self._disposers[-1] is fn:
                    self._disposers.pop()
        self.disposed = True
        return errors

    def __len__(self) -> int:
        return len(self._disposers)
