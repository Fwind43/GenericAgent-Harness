"""Opt-in real GA tool-method acceptance, without importing GA or credentials."""
import ast
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace as NS

import pytest

from tests.test_workspaces import setup, project


def test_real_ga_tool_cwd(tmp_path):
    root = os.environ.get("GAH_TEST_GA_ROOT")
    if not root:
        pytest.skip("set GAH_TEST_GA_ROOT to test installed GA methods without importing GA")
    source = Path(root, "ga.py")
    tree = ast.parse(source.read_text("utf-8"))
    handler_class = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "GenericAgentHandler")
    selected = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("_arg", "code_run")]
    selected += [n for n in handler_class.body if isinstance(n, ast.FunctionDef) and n.name in ("_get_abs_path", "do_code_run")]
    assert len(selected) == 4
    # Only logging/result wrappers are substituted; tool path and subprocess code are unchanged.
    ns = dict(os=os, sys=sys, json=json, re=re, subprocess=subprocess,
              tempfile=tempfile, threading=threading, time=time, script_dir=str(Path(root).resolve()),
              safe_print=lambda *a, **k: None, smart_format=lambda value, **k: value,
              StepOutcome=lambda value, **k: NS(result=value))
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(source), "exec"), ns)
    raw, sessions, ws = setup(tmp_path)
    original_cwd = os.getcwd()
    for name in ("alpha", "beta"):
        directory = tmp_path / name
        directory.mkdir()
        project(ws, directory, name=name)
        handler = NS(parent=raw, cwd=original_cwd, code_stop_signal=False,
                     _get_tool_maxlen=lambda default, args: default,
                     _get_anchor_prompt=lambda **k: "", print=lambda *a, **k: None)

        def execute(_):
            ws.bind({"handler": handler}, lambda value: value)
            assert ns["_get_abs_path"](handler, "receipt.txt") == str(directory / "receipt.txt")
            script = "from pathlib import Path; p=Path.cwd(); Path('receipt.txt').write_text(str(p), encoding='utf8'); print(p)"
            gen = ns["do_code_run"](handler, {"script": script, "timeout": 10}, "")
            while True:
                try:
                    next(gen)
                except StopIteration as done:
                    assert done.value.result["status"] == "success", done.value.result
                    assert done.value.result["exit_code"] == 0
                    assert str(directory) in done.value.result["stdout"]
                    break

        ws.request({}, execute)
        assert (directory / "receipt.txt").read_text("utf8") == str(directory)
        assert os.getcwd() == original_cwd
        assert not sessions.reserved
    assert not (tmp_path / "receipt.txt").exists()
