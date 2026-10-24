"""ui-cli: the original `gah run "task"` behaviour, as a frontend plugin.

Frontend contract (shared by every ui-* plugin): provide ``frontend`` with
``main(task: str | None = None, timeout: float | None = None) -> int``. The CLI mounts
the tree, then hands the main thread to ``frontend.main`` and exits with its code.
"""
import sys


class CliFrontend:
    def __init__(self, ctx, config):
        self.ctx = ctx
        self.out = config.get("stream") or sys.stdout

    def main(self, task=None, timeout=None) -> int:
        if not task:
            print("[ui-cli] a task is required: gah run \"task\" (or use --ui tui)", file=sys.stderr)
            return 2
        off = self.ctx.events.on("agent.chunk", self._write)
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
