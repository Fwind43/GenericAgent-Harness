"""ga-file-changes: files changed by file_write/file_patch, reported once per run."""
import types
from pathlib import Path

import pytest

from ga_harness.kernel import Runtime
from ga_harness.kernel.loader import build_tree, discover, mount
from ga_harness.worker import DEFAULT_PLUGINS, WorkerHost

ROOT = Path(__file__).resolve().parents[1]
GA_ROOT = Path(r"E:\Work\GenericAgent")
PLUGINS = ROOT / "ga_harness" / "plugins"
pytestmark = pytest.mark.skipif(not (GA_ROOT / "plugins" / "hooks.py").exists(), reason="GA not present")


class Handler:
    def __init__(self, cwd):
        self.cwd = str(cwd)
        self.current_turn = 0

    def _get_abs_path(self, path):
        p = Path(path)
        return str(p if p.is_absolute() else Path(self.cwd) / p)


def _mount(with_host=True, config=None):
    rt = Runtime()
    sent = []
    if with_host:
        rt.ctx.provide("run.host", WorkerHost(lambda kind, **data: sent.append(dict(kind=kind, **data)), "r1", "s1"))
    tree = [{"name": "ga-hooks", "disabled": False, "config": {"ga_root": str(GA_ROOT)}},
            {"name": "ga-file-changes", "disabled": False, "config": config or {}}]
    mount(rt, tree, discover([PLUGINS]))
    return rt, rt.ctx.get("ga.hooks"), sent


def _tool(hooks, handler, name, path, ok=True, write=None, turn=1):
    handler.current_turn = turn
    args = {"path": path}
    hooks.trigger("tool_before", {"self": handler, "tool_name": name, "args": args})
    if ok and write is not None:
        write()
    ret = types.SimpleNamespace(data={"status": "success" if ok else "error"})
    hooks.trigger("tool_after", {"self": handler, "tool_name": name, "args": args, "ret": ret})


def _unmount(rt):
    rt.remove("ga-file-changes")
    rt.remove("ga-hooks")


def test_enabled_by_default():
    names = [e["name"] for e in build_tree("ga-compat", [ROOT / "ga_harness" / "profiles"], [])]
    assert names.index("ga-file-changes") > names.index("ga-hooks")
    assert "ga-file-changes" in DEFAULT_PLUGINS


def test_reports_created_and_modified_files(tmp_path):
    existing = tmp_path / "README.md"
    existing.write_text("x", encoding="utf8")
    new = tmp_path / "src" / "new.py"
    rt, hooks, sent = _mount()
    h = Handler(tmp_path)
    hooks.trigger("agent_before", {"handler": h})

    def create():
        new.parent.mkdir()
        new.write_text("y", encoding="utf8")
    _tool(hooks, h, "file_write", "src/new.py", write=create, turn=1)
    _tool(hooks, h, "file_patch", "README.md", turn=2)
    _tool(hooks, h, "file_patch", str(existing), turn=3)      # same file via absolute path
    _tool(hooks, h, "file_patch", "missing.txt", ok=False, turn=3)   # failed -> ignored
    _tool(hooks, h, "file_read", "README.md", turn=3)          # not a write tool
    _tool(hooks, h, "code_run", "README.md", turn=3)
    hooks.trigger("agent_after", {"exit_reason": {}})

    assert len(sent) == 1 and sent[0]["kind"] == "event" and sent[0]["name"] == "plugin.file_changes"
    data = sent[0]["data"]
    assert data["base"] == str(tmp_path)
    assert data["files"] == [
        {"path": str(new), "action": "created", "count": 1, "turns": [1]},
        {"path": str(existing), "action": "modified", "count": 2, "turns": [2, 3]},
    ]
    assert data["notes"] == [{"kind": "files", "text": "+ src/new.py\n~ README.md (x2)"}]
    assert rt.ctx.get("ga.file_changes")() == data["files"]
    _unmount(rt)


def test_each_run_starts_empty_and_no_event_without_changes(tmp_path):
    rt, hooks, sent = _mount()
    h = Handler(tmp_path)
    hooks.trigger("agent_before", {"handler": h})
    _tool(hooks, h, "file_write", "a.txt")
    hooks.trigger("agent_after", {})
    hooks.trigger("agent_before", {"handler": h})
    _tool(hooks, h, "file_patch", "a.txt", ok=False)
    hooks.trigger("agent_after", {})
    assert len(sent) == 1
    hooks.trigger("agent_before", {"handler": h})
    _tool(hooks, h, "file_write", "b.txt")
    hooks.trigger("agent_after", {})
    assert [f["path"] for f in sent[-1]["data"]["files"]] == [str(tmp_path / "b.txt")]
    _unmount(rt)


def test_limit_and_paths_outside_base(tmp_path):
    rt, hooks, sent = _mount(config={"max_files": 2})
    h = Handler(tmp_path / "work")
    outside = tmp_path / "other.txt"
    hooks.trigger("agent_before", {"handler": h})
    for name in ("a.txt", "b.txt", "c.txt"):
        _tool(hooks, h, "file_write", name)
    _tool(hooks, h, "file_write", str(outside))
    hooks.trigger("agent_after", {})
    data = sent[0]["data"]
    assert len(data["files"]) == 4                       # structured list is complete
    assert data["notes"][0]["text"] == "+ a.txt\n+ b.txt\n... +2"
    _unmount(rt)


def test_outside_base_shows_absolute_path(tmp_path):
    rt, hooks, sent = _mount()
    h = Handler(tmp_path / "work")
    outside = tmp_path / "other.txt"
    hooks.trigger("agent_before", {"handler": h})
    _tool(hooks, h, "file_write", str(outside))
    hooks.trigger("agent_after", {})
    assert sent[0]["data"]["notes"][0]["text"] == "+ " + str(outside).replace("\\", "/")
    _unmount(rt)


def test_without_run_host_only_keeps_list(tmp_path):
    rt, hooks, sent = _mount(with_host=False)
    h = Handler(tmp_path)
    hooks.trigger("agent_before", {"handler": h})
    _tool(hooks, h, "file_write", "a.txt")
    hooks.trigger("agent_after", {})
    assert sent == []
    assert [f["path"] for f in rt.ctx.get("ga.file_changes")()] == [str(tmp_path / "a.txt")]
    _unmount(rt)
