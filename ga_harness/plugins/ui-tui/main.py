"""ui-tui: multi-turn terminal frontend (stdlib only).

The task runs on a worker thread; the main thread waits on it so Ctrl+C (or Ctrl+Break on
Windows) lands here and becomes ``agent.abort()``. At the prompt, Ctrl+C / EOF / /exit quit.
Local commands: /exit /quit /help. Any other line (including GA's own slash commands such as
``/session.x=...``) goes to the agent unchanged.

Output is rendered from ga-events by ``ga_harness.textview``; config ``raw = true`` prints
GA's raw ``agent.chunk`` text instead, ``tool_lines`` limits result lines per tool call.
"""
import signal
import sys
import threading

from ga_harness.textview import TextView

HELP = "commands: /exit /quit /help   Ctrl+C while running = abort the task"


class TuiFrontend:
    def __init__(self, ctx, config):
        self.ctx = ctx
        console = ctx.get("console")
        self.out = config.get("stream") or (console.out if console else sys.stdout)
        self.read = config.get("input") or input
        self.prompt = config.get("prompt", "\n> ")
        self.turns = 0
        self.view = TextView(ctx, self._w, raw=bool(config.get("raw", False)),
                             tool_lines=int(config.get("tool_lines", 3)),
                             show_log=bool(config.get("show_log", False)))

    def _w(self, text):
        self.out.write(text)
        self.out.flush()

    def main(self, task=None, timeout=None) -> int:
        if hasattr(signal, "SIGBREAK") and threading.current_thread() is threading.main_thread():
            signal.signal(signal.SIGBREAK, signal.default_int_handler)
        off = self.view.attach()
        try:
            self._w("[ga-harness tui] " + HELP + "\n")
            pending = task
            while True:
                if pending is None:
                    try:
                        self._w(self.prompt)   # not via input(): sys.stdout may be captured
                        pending = self.read("")
                    except (EOFError, KeyboardInterrupt):
                        self._w("\n")
                        return 0
                line, pending = pending.strip(), None
                if not line:
                    continue
                if line in ("/exit", "/quit"):
                    return 0
                if line == "/help":
                    self._w(HELP + "\n")
                    continue
                self._turn(line, timeout)
        finally:
            off()

    def _turn(self, line, timeout):
        agent = self.ctx.get("agent")
        box = {}
        self.view.begin()

        def work():
            try:
                box["result"] = agent.run(line, timeout=timeout)
            except BaseException as e:  # surfaced on the main thread
                box["error"] = e

        t = threading.Thread(target=work, name="ui-tui-turn", daemon=True)
        t.start()
        aborted = False
        while t.is_alive():
            try:
                t.join(0.2)
            except KeyboardInterrupt:
                if aborted:          # second Ctrl+C: stop waiting
                    self._w("\n[tui] still stopping; detached\n")
                    return
                aborted = True
                self._w("\n[tui] aborting...\n")
                agent.abort()
        self.turns += 1
        self._w("\n")
        if "error" in box:
            self._w(f"[tui] error: {box['error']}\n")
        elif aborted:
            self._w("[tui] aborted\n")


def apply(ctx, config):
    ctx.provide("frontend", TuiFrontend(ctx, config or {}))
