"""ga-stdout: take over GA's own print() output.

GA prints status lines ("[Info] ...", "[Debug] ...", code_run output, ...) straight to
sys.stdout / sys.stderr. Mounted before ga-core, this plugin swaps both for line-buffered
proxies: every complete line becomes ``agent.log`` ``{"stream": "stdout"|"stderr", "text"}``
and nothing reaches the terminal unless asked to. Frontends must write their own output to
the ``console`` capability (the real streams), never to ``sys.stdout``.

config:
  passthrough  also copy captured lines to the real stream (default false)
  file         append captured lines to this file (default none)

Provides
  console  object with ``out`` / ``err`` (the original sys.stdout / sys.stderr)
"""
import io
import sys
import threading
import time


class Console:
    def __init__(self, out, err):
        self.out = out
        self.err = err


class _Proxy(io.TextIOBase):
    def __init__(self, sink, name, real):
        self._sink = sink
        self._name = name
        self._real = real
        self._buf = ""
        self._lock = threading.Lock()

    # attributes some callers probe on sys.stdout
    @property
    def encoding(self):
        return getattr(self._real, "encoding", "utf-8")

    def isatty(self):
        return False

    def writable(self):
        return True

    def fileno(self):
        return self._real.fileno()

    def write(self, s):
        if not isinstance(s, str):
            s = str(s)
        if self._sink.busy():          # a log listener printed: don't loop
            self._real.write(s)
            return len(s)
        with self._lock:
            self._buf += s
            *lines, self._buf = self._buf.replace("\r\n", "\n").split("\n")
        for line in lines:
            self._sink.line(self._name, line)
        return len(s)

    def flush(self):
        with self._lock:
            rest, self._buf = self._buf, ""
        if rest:
            self._sink.line(self._name, rest)

    def __getattr__(self, item):
        return getattr(self._real, item)


class _Sink:
    def __init__(self, ctx, console, config):
        self.ctx = ctx
        self.console = console
        self.passthrough = bool(config.get("passthrough", False))
        self.path = config.get("file")
        self._local = threading.local()
        self._flock = threading.Lock()

    def busy(self):
        return getattr(self._local, "busy", False)

    def line(self, stream, text):
        self._local.busy = True
        try:
            if self.passthrough:
                real = self.console.err if stream == "stderr" else self.console.out
                real.write(text + "\n")
                real.flush()
            if self.path:
                with self._flock, open(self.path, "a", encoding="utf-8") as f:
                    f.write(f"{time.strftime('%H:%M:%S')} {stream} {text}\n")
            self.ctx.emit("agent.log", {"stream": stream, "text": text})
        finally:
            self._local.busy = False


def apply(ctx, config):
    config = config or {}
    real_out, real_err = sys.stdout, sys.stderr
    console = Console(real_out, real_err)
    sink = _Sink(ctx, console, config)
    out, err = _Proxy(sink, "stdout", real_out), _Proxy(sink, "stderr", real_err)
    sys.stdout, sys.stderr = out, err

    def restore():
        for p in (out, err):
            try:
                p.flush()
            except Exception:
                pass
        if sys.stdout is out:
            sys.stdout = real_out
        if sys.stderr is err:
            sys.stderr = real_err
    ctx.scope.add(restore)
    ctx.provide("console", console)
