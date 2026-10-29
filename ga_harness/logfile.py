"""Persistent log files under ``$GAH_HOME/logs``.

Before this, everything went to the console only, so a crash was lost once the window
scrolled or closed. ``setup("host")`` / ``setup("worker")`` add, per process:

* the ``logging`` root logger -> a file (INFO and up), console keeps WARNING and up;
* raw stderr (tracebacks printed by threads, multiprocessing, http.server, print) is
  teed into the same file, while still reaching the console;
* uncaught exceptions in the main thread and in other threads are logged;
* ``faulthandler`` dumps native crashes / hard faults to ``faults.log``.

Files:
  host.log          the web/CLI host, rotated at 5 MiB, 5 backups
  worker-YYYYMMDD.log  all run worker processes of that day (several processes may
                    append at once, so these are not size-rotated; older than
                    ``KEEP_DAYS`` are removed when the host starts)
  faults.log        native crash dumps of any process
"""
from __future__ import annotations

import faulthandler
import logging
import logging.handlers
import os
import sys
import threading
import time
from pathlib import Path

from . import paths

FORMAT = "%(asctime)s.%(msecs)03d %(process)d %(threadName)s %(levelname)s %(name)s: %(message)s"
DATEFMT = "%Y-%m-%d %H:%M:%S"
KEEP_DAYS = 14
_state: dict = {}


def log_dir() -> Path:
    return paths.home() / "logs"


class _Tee:
    """Line-buffered stderr wrapper: writes go to the original stream unchanged and each
    complete line is also written to the log file (through ``handler``)."""

    def __init__(self, stream, handler):
        self._stream = stream
        self._handler = handler
        self._buf = ""
        self._local = threading.local()
        self._lock = threading.Lock()

    def write(self, text):
        n = 0
        if self._stream is not None:
            try:
                n = self._stream.write(text)
            except Exception:
                pass
        if getattr(self._local, "busy", False):  # handler error output: don't loop
            return n if n is not None else len(text)
        self._local.busy = True
        try:
            with self._lock:
                self._buf += text
                lines = self._buf.split("\n")
                self._buf = lines.pop()
            for line in lines:
                if line.strip():
                    self._emit(line.rstrip("\r"))
        finally:
            self._local.busy = False
        return n if n is not None else len(text)

    def _emit(self, line):
        record = logging.LogRecord("stderr", logging.WARNING, "", 0, line, None, None)
        try:
            self._handler.handle(record)
        except Exception:
            pass

    def flush(self):
        if self._stream is not None:
            try:
                self._stream.flush()
            except Exception:
                pass

    def __getattr__(self, name):  # encoding, isatty, fileno, ...
        return getattr(self._stream, name)


def _prune(directory: Path) -> None:
    cutoff = time.time() - KEEP_DAYS * 86400
    for path in directory.glob("worker-*.log"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            pass


def setup(kind: str = "host") -> Path | None:
    """Idempotent per process. Never raises: logging must not stop the program."""
    if _state.get("file"):
        return _state["file"]
    try:
        directory = log_dir()
        directory.mkdir(parents=True, exist_ok=True)
        if kind == "host":
            file = directory / "host.log"
            handler = logging.handlers.RotatingFileHandler(
                file, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8", delay=False)
            _prune(directory)
        else:
            file = directory / f"worker-{time.strftime('%Y%m%d')}.log"
            handler = logging.FileHandler(file, encoding="utf-8")
        handler.setFormatter(logging.Formatter(FORMAT, DATEFMT))
        handler.setLevel(logging.INFO)

        root = logging.getLogger()
        root.setLevel(logging.INFO)
        root.addHandler(handler)
        # Console: keep the old behaviour (warnings and errors only). Use the real stderr,
        # not sys.stderr, which plugins (ga-stdout) may replace with an event proxy.
        console_stream = sys.__stderr__
        if console_stream is not None:
            console = logging.StreamHandler(console_stream)
            console.setLevel(logging.WARNING)
            console.setFormatter(logging.Formatter("[%(levelname)s] %(name)s: %(message)s"))
            root.addHandler(console)

        tee = _Tee(sys.stderr, handler)
        sys.stderr = tee
        sys.__stderr__ = tee  # so later "real stderr" users (cli._err, ga-stdout) are kept too

        def excepthook(exc_type, exc, tb):
            logging.getLogger("uncaught").critical("uncaught exception", exc_info=(exc_type, exc, tb))

        def thread_excepthook(args):
            if args.exc_type is SystemExit:
                return
            name = args.thread.name if args.thread is not None else "?"
            logging.getLogger("uncaught").critical(
                "uncaught exception in thread %s", name,
                exc_info=(args.exc_type, args.exc_value, args.exc_traceback))

        sys.excepthook = excepthook
        threading.excepthook = thread_excepthook

        try:
            faults = open(directory / "faults.log", "a", encoding="utf-8")
            faults.write(f"--- {time.strftime(DATEFMT)} {kind} pid={os.getpid()}\n")
            faults.flush()
            faulthandler.enable(file=faults, all_threads=True)
            _state["faults"] = faults
        except Exception:
            pass

        _state["file"] = file
        logging.getLogger("gah").info("%s started pid=%s argv=%s", kind, os.getpid(), sys.argv)
        return file
    except Exception:
        return None
