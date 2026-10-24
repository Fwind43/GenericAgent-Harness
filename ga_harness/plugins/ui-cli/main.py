"""ui-cli: the original `gah run "task"` behaviour, as a frontend plugin.

Frontend contract (shared by every ui-* plugin): provide ``frontend`` with
``main(task: str | None = None, timeout: float | None = None) -> int``. The CLI mounts
the tree, then hands the main thread to ``frontend.main`` and exits with its code.

Output is rendered from ga-events by ``ga_harness.textview`` (steps, tool calls, results);
GA's raw display text is shown only when no structured events arrive.
config:
  stream      output stream (default stdout)
  raw         print GA's raw ``agent.chunk`` text instead (default false)
  tool_lines  result lines shown per tool call (default 3)
  show_log    also show GA's captured print() lines (`agent.log`, default false)
"""
import sys

from ga_harness.textview import TextView


class CliFrontend:
    def __init__(self, ctx, config):
        self.ctx = ctx
        console = ctx.get("console")
        self.out = config.get("stream") or (console.out if console else sys.stdout)
        self.err = console.err if console else sys.stderr
        self.view = TextView(ctx, self._write, raw=bool(config.get("raw", False)),
                             tool_lines=int(config.get("tool_lines", 3)),
                             show_log=bool(config.get("show_log", False)))

    def main(self, task=None, timeout=None) -> int:
        if not task:
            print("[ui-cli] a task is required: gah run \"task\" (or use --ui tui)", file=self.err)
            return 2
        off = self.view.attach()
        self.view.begin()
        try:
            self.ctx.get("agent").run(task, timeout=timeout)
        finally:
            off()
        self.out.write("\n")
        self.out.flush()
        return 0

    def _write(self, text):
        self.out.write(text)
        self.out.flush()


def apply(ctx, config):
    ctx.provide("frontend", CliFrontend(ctx, config or {}))
