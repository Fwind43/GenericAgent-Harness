import faulthandler
import logging
import sys
import threading

import pytest

from ga_harness import logfile


@pytest.fixture(autouse=True)
def _isolated_logfile(tmp_path_factory, monkeypatch):
    """``cli.main`` calls ``logfile.setup("host")``, which is once-per-process: it tees the
    stderr it sees first into ``sys.stderr`` *and* ``sys.__stderr__`` and installs global
    hooks. In one pytest process that pins every later test's stderr to the first test's
    capture, so ``capfd`` reads nothing. Give each test its own log dir (not the
    repository's ``data/logs``) and undo the process-wide state afterwards."""
    monkeypatch.setenv("GAH_LOG_DIR", str(tmp_path_factory.mktemp("logs")))
    saved = (sys.stderr, sys.__stderr__, sys.excepthook, threading.excepthook)
    root = logging.getLogger()
    handlers, level = list(root.handlers), root.level
    yield
    sys.stderr, sys.__stderr__, sys.excepthook, threading.excepthook = saved
    for h in root.handlers[:]:
        if h not in handlers:
            root.removeHandler(h)
            h.close()
    root.setLevel(level)
    faults = logfile._state.pop("faults", None)
    if faults is not None:
        faulthandler.disable()
        faults.close()
    logfile._state.clear()
