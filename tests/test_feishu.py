"""Tests for the built-in Feishu/Lark channel plugin lifecycle and race safety."""
from __future__ import annotations

import importlib.util
import io
import json
import os
import threading
from pathlib import Path


def _load_feishu():
    path = Path(__file__).resolve().parents[1] / "ga_harness" / "plugins" / "feishu" / "main.py"
    spec = importlib.util.spec_from_file_location("gah_feishu_main", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _PipeProc:
    """Fake subprocess backed by an os.pipe so stdout blocks until killed/closed."""

    def __init__(self, exit_code: int = -9):
        rfd, self._wfd = os.pipe()
        self.stdout = os.fdopen(rfd, "rb")
        self._code: int | None = None
        self._exit_code = exit_code
        self._done = threading.Event()
        self._lock = threading.Lock()

    def write_line(self, obj: dict) -> None:
        os.write(self._wfd, (json.dumps(obj) + "\n").encode("utf-8"))

    def finish(self, code: int = 0) -> None:
        with self._lock:
            if self._wfd is not None:
                os.close(self._wfd)
                self._wfd = None
            if self._code is None:
                self._code = code
        self._done.set()

    def poll(self):
        return self._code

    def kill(self):
        self.finish(self._exit_code)

    def wait(self, timeout=None):
        self._done.wait(timeout=timeout)
        return 0 if self._code is None else self._code


def test_feishu_stop_does_not_crash_reader_thread(monkeypatch):
    feishu = _load_feishu()
    uncaught = []
    monkeypatch.setattr(threading, "excepthook", lambda args: uncaught.append(args))

    logs = []
    dead = []
    adapter = feishu.FeishuAdapter(
        "feishu-test", "cli_a", "sec_b", set(),
        log=lambda level, text: logs.append((level, text)),
        on_dead=dead.append,
    )
    proc = _PipeProc()
    monkeypatch.setattr(feishu.subprocess, "Popen", lambda *a, **kw: proc)
    monkeypatch.setattr("ga_harness.packages.python_for", lambda *a, **kw: "python")

    adapter.start(object())
    proc.write_line({"type": "log", "level": "info", "text": "connecting to Feishu"})
    reader = adapter.reader
    assert reader is not None and reader.is_alive()

    adapter.stop()
    reader.join(timeout=2)

    assert not reader.is_alive()
    assert uncaught == []
    assert dead == []
    assert adapter.proc is None
    assert adapter.reader is None
    assert adapter.client is None
    assert ("info", "stopped") in logs


def test_feishu_read_survives_proc_cleared_before_wait():
    feishu = _load_feishu()
    logs = []
    dead = []
    adapter = feishu.FeishuAdapter(
        "feishu-race", "cli_a", "sec_b", set(),
        log=lambda level, text: logs.append((level, text)),
        on_dead=dead.append,
    )

    class ClearingOnWaitProc:
        def __init__(self):
            self.stdout = io.BytesIO(b"")

        def wait(self, timeout=None):
            return 0

    proc = ClearingOnWaitProc()
    # Simulate the narrow race where stop() already cleared adapter.proc to None
    # before _read(proc) reaches proc.wait(), and sets stopping=True.
    adapter.proc = None
    adapter.stopping = True
    adapter._read(proc)

    assert dead == []
    assert logs == []


def test_feishu_unexpected_worker_exit_triggers_on_dead_even_after_restart(monkeypatch):
    feishu = _load_feishu()
    logs = []
    dead = []
    adapter = feishu.FeishuAdapter(
        "feishu-crash", "cli_a", "sec_b", set(),
        log=lambda level, text: logs.append((level, text)),
        on_dead=dead.append,
    )
    procs = []

    def fake_popen(*a, **kw):
        p = _PipeProc()
        procs.append(p)
        return p

    monkeypatch.setattr(feishu.subprocess, "Popen", fake_popen)
    monkeypatch.setattr("ga_harness.packages.python_for", lambda *a, **kw: "python")

    # First run -> normal stop (sets stopping=True)
    adapter.start(object())
    adapter.stop()
    assert dead == []

    # Second run -> start() must reset stopping=False so real crashes still report on_dead
    adapter.start(object())
    assert adapter.stopping is False
    reader = adapter.reader
    procs[-1].write_line({"type": "fatal", "text": "RuntimeError: invalid credential"})
    procs[-1].finish(code=1)
    reader.join(timeout=2)

    assert dead == ["receiver exited (code 1)"]
    assert ("error", "RuntimeError: invalid credential") in logs
    assert ("error", "receiver exited (code 1)") in logs
    adapter.stop()


def _load_ws_worker():
    path = Path(__file__).resolve().parents[1] / "ga_harness" / "plugins" / "feishu" / "ws_worker.py"
    spec = importlib.util.spec_from_file_location("gah_feishu_ws_worker", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_feishu_worker_is_told_its_parent_pid(monkeypatch):
    feishu = _load_feishu()
    adapter = feishu.FeishuAdapter("feishu-pid", "cli_a", "sec_b", set(),
                                   log=lambda level, text: None, on_dead=lambda reason: None)
    seen = {}
    proc = _PipeProc()

    def fake_popen(*a, **kw):
        seen.update(kw)
        return proc

    monkeypatch.setattr(feishu.subprocess, "Popen", fake_popen)
    monkeypatch.setattr("ga_harness.packages.python_for", lambda *a, **kw: "python")
    adapter.start(object())
    try:
        assert seen["env"]["GAH_PARENT_PID"] == str(os.getpid())
    finally:
        adapter.stop()


def test_feishu_worker_exits_when_parent_is_gone():
    """An orphaned receiver must not outlive the harness that spawned it."""
    import subprocess
    import sys
    import time
    worker = _load_ws_worker()

    # a live parent: keeps watching, never fires
    alive = []
    thread = worker.watch_parent(os.getpid(), on_exit=alive.append)
    time.sleep(0.3)
    assert thread.is_alive() and alive == []

    # a parent that exits: fires once
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(0.3)"])
    gone = []
    thread = worker.watch_parent(child.pid, on_exit=gone.append)
    child.wait(timeout=10)
    thread.join(timeout=10)
    assert gone == [0]
