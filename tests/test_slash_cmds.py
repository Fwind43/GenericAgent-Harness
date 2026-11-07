import importlib.util
import sys
import types
from pathlib import Path


def _load_main():
    path = Path(__file__).resolve().parents[1] / "ga_harness" / "plugins" / "ga-core" / "main.py"
    spec = importlib.util.spec_from_file_location("_ga_core_main_slash", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_update_slash_cmd_uses_slash_keyed_table(monkeypatch, tmp_path):
    # Current GA keys prompt_for's table by "/update", not "update".
    fake = types.ModuleType("frontends.slash_cmds")
    fake.prompt_for = lambda cmd, args: {"/update": "UPDATE PROMPT"}.get(cmd)
    pkg = types.ModuleType("frontends")
    pkg.slash_cmds = fake
    monkeypatch.setitem(sys.modules, "frontends", pkg)
    monkeypatch.setitem(sys.modules, "frontends.slash_cmds", fake)
    m = _load_main()
    out = m._expand_slash_cmd("/update", str(tmp_path))
    assert out.startswith("UPDATE PROMPT")
    assert "[Harness /update context]" in out
    assert m._expand_slash_cmd("/unknown x", str(tmp_path)) == "/unknown x"
    assert m._expand_slash_cmd("hello", str(tmp_path)) == "hello"
