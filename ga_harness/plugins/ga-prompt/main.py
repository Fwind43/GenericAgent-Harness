"""ga-prompt: GA's system prompt as a waterfall.

agentmain.run() calls the module global ``get_system_prompt()`` once per task.
This plugin replaces it with one that runs the ``ga.system_prompt`` waterfall
(core = GA's original builder), so any plugin can rewrite the prompt via
``ctx.on("ga.system_prompt", lambda prompt, nxt: nxt(prompt) + "...")``.

config:
  prepend / append   text added before / after GA's prompt
  replace_file       read the base prompt from this file instead of GA's
"""
from __future__ import annotations
import sys
from pathlib import Path


def apply(ctx, config):
    mod = sys.modules[type(ctx.get("ga.agent")).__module__]
    orig = mod.get_system_prompt
    pre, post = config.get("prepend", ""), config.get("append", "")
    rfile = config.get("replace_file")

    def base(_):
        if rfile:
            return Path(rfile).expanduser().read_text(encoding="utf-8")
        return orig()

    def get_system_prompt():
        p = ctx.waterfall("ga.system_prompt", "", base)
        if pre:
            p = pre + "\n" + p
        if post:
            p = p + "\n" + post
        return p
    get_system_prompt.__wrapped__ = orig
    mod.get_system_prompt = get_system_prompt

    def restore():
        if mod.get_system_prompt is get_system_prompt:
            mod.get_system_prompt = orig
    ctx.scope.add(restore)
    ctx.provide("ga.prompt", get_system_prompt)
