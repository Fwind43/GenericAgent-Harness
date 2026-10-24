"""ga-tools: GA's tool set as a plugin-managed registry.

GA reads two things per task: the module global ``agentmain.TOOLS_SCHEMA`` (what the
LLM sees) and ``GenericAgentHandler.do_<name>`` (what dispatch() runs). GA rebuilds
TOOLS_SCHEMA inside ``load_tool_schema()`` (import time and every LLM switch), so this
plugin wraps that function and re-applies its overlay after each rebuild.

service ``ga.tools``:
  register(schema, fn) -> disposer   fn(handler, args, response) -> StepOutcome
  disable(name) -> disposer          hidden from the LLM; calls are refused
  names() -> list[str]               tools currently visible to the LLM

config:
  disable   tool names to disable, e.g. ["web_scan", "web_execute_js"]
"""
from __future__ import annotations
import importlib
import sys

_MISSING = object()


class ToolRegistry:
    def __init__(self, mod):
        self.mod = mod
        self.cls = mod.GenericAgentHandler
        self.added: dict[str, tuple[dict, object]] = {}
        self.disabled: dict[str, int] = {}
        self._saved: dict[str, object] = {}
        self._orig_load = mod.load_tool_schema
        loader = self._orig_load

        def load_tool_schema(*a, **kw):
            r = loader(*a, **kw)
            self._overlay()
            return r
        load_tool_schema.__wrapped__ = loader
        mod.load_tool_schema = load_tool_schema

    # ---- schema --------------------------------------------------------
    def _overlay(self):
        schema = [t for t in self.mod.TOOLS_SCHEMA
                  if _name(t) not in self.added and _name(t) not in self.disabled]
        schema += [s for n, (s, _) in self.added.items() if n not in self.disabled]
        self.mod.TOOLS_SCHEMA = schema

    def refresh(self):
        self._orig_load()
        self._overlay()

    def names(self) -> list[str]:
        return [_name(t) for t in self.mod.TOOLS_SCHEMA]

    # ---- handler methods -----------------------------------------------
    def _set(self, name: str, fn):
        attr = "do_" + name
        if attr not in self._saved:
            self._saved[attr] = self.cls.__dict__.get(attr, _MISSING)
        setattr(self.cls, attr, fn)

    def _restore(self, name: str):
        attr = "do_" + name
        if name in self.disabled:
            self._set(name, _refuser(name))
        elif name in self.added:
            self._set(name, self.added[name][1])
        else:
            old = self._saved.pop(attr, _MISSING)
            if old is _MISSING:
                if attr in self.cls.__dict__:
                    delattr(self.cls, attr)
            else:
                setattr(self.cls, attr, old)

    # ---- public API ----------------------------------------------------
    def register(self, schema: dict, fn):
        name = _name(schema)
        if not name:
            raise ValueError("tool schema needs function.name")
        if name in self.added:
            raise KeyError(f"tool {name!r} already registered by a plugin")
        self.added[name] = (schema, fn)
        if name not in self.disabled:
            self._set(name, fn)
        self._overlay_fresh()

        def dispose():
            if self.added.get(name, (None, None))[1] is fn:
                del self.added[name]
                self._restore(name)
                self.refresh()
        return dispose

    def disable(self, name: str):
        self.disabled[name] = self.disabled.get(name, 0) + 1
        self._set(name, _refuser(name))
        self._overlay_fresh()

        def dispose(done=[]):
            if done:
                return
            done.append(1)
            self.disabled[name] -= 1
            if not self.disabled[name]:
                del self.disabled[name]
                self._restore(name)
                self.refresh()
        return dispose

    def _overlay_fresh(self):
        self.refresh()

    def close(self):
        self.mod.load_tool_schema = self._orig_load
        self.added.clear()
        self.disabled.clear()
        for attr in list(self._saved):
            self._restore(attr[3:])
        self._orig_load()


def _name(t: dict) -> str:
    return (t.get("function") or {}).get("name", "")


def _refuser(name: str):
    def refuse(self, args, response):
        StepOutcome = importlib.import_module("agent_loop").StepOutcome
        msg = f"[Error] Tool '{name}' is disabled in this harness profile. Use another tool."
        return StepOutcome(msg, next_prompt=msg + "\n")
    refuse.__name__ = "do_" + name
    return refuse


def apply(ctx, config):
    mod = sys.modules[type(ctx.get("ga.agent")).__module__]
    reg = ToolRegistry(mod)
    ctx.scope.add(reg.close)
    for n in config.get("disable", []):
        reg.disable(n)
    ctx.provide("ga.tools", reg)
