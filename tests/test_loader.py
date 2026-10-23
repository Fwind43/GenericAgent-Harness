import textwrap
from pathlib import Path
import pytest
from ga_harness.kernel import Runtime
from ga_harness.kernel.loader import apply_patch, build_tree, discover, mount


def w(p: Path, s: str):
    p.parent.mkdir(parents=True, exist_ok=True); p.write_text(textwrap.dedent(s), encoding="utf-8")


@pytest.fixture
def env(tmp_path):
    w(tmp_path / "plugins/greeter/plugin.toml", """
        name = "greeter"
        entry = "main:apply"
        provides = ["greeter"]
    """)
    w(tmp_path / "plugins/greeter/main.py", """
        def apply(ctx, cfg):
            ctx.provide("greeter", lambda: cfg.get("word", "hi"))
    """)
    w(tmp_path / "plugins/user/plugin.toml", 'name = "user"\ninject = ["greeter"]\n')
    w(tmp_path / "plugins/user/main.py", """
        from .helper import shout
        def apply(ctx, cfg):
            ctx.provide("said", shout(ctx.greeter()))
    """)
    w(tmp_path / "plugins/user/helper.py", "def shout(s):\n    return s.upper()\n")
    w(tmp_path / "profiles/base.toml", """
        [[plugins]]
        name = "greeter"
        config = { word = "hello", extra = { a = 1 } }
        [[plugins]]
        name = "user"
    """)
    w(tmp_path / "profiles/quiet.toml", """
        extends = "base"
        [[patch]]
        id = "user"
        disabled = true
    """)
    return tmp_path


def test_discover_and_mount_with_relative_import(env):
    ms = discover([env / "plugins"])
    assert set(ms) == {"greeter", "user"} and ms["user"].inject == ["greeter"]
    rt = Runtime()
    tree = build_tree("base", [env / "profiles"])
    assert mount(rt, tree, ms) == ["greeter", "user"]
    assert rt.ctx.said == "HELLO"


def test_extends_and_layered_patches(env):
    w(env / "user.toml", """
        [[patch]]
        id = "greeter"
        config = { extra = { b = 2 } }
    """)
    tree = build_tree("quiet", [env / "profiles"], [env / "user.toml"],
                      [{"id": "user", "disabled": False}, {"id": "greeter", "config": {"word": "yo"}}])
    g = tree[0]
    assert g["config"] == {"word": "yo", "extra": {"a": 1, "b": 2}}
    assert tree[1] == {"name": "user", "config": {}, "disabled": False}


def test_patch_ops():
    t = [{"name": "a", "config": {}, "disabled": False}]
    t = apply_patch(t, {"insert": {"name": "b"}, "before": "a"})
    t = apply_patch(t, {"insert": {"name": "c"}, "after": "a"})
    assert [e["name"] for e in t] == ["b", "a", "c"]
    t = apply_patch(t, {"remove": "a"})
    assert [e["name"] for e in t] == ["b", "c"]
    with pytest.raises(KeyError):
        apply_patch(t, {"id": "zzz", "disabled": True})


def test_extends_cycle(tmp_path):
    w(tmp_path / "a.toml", 'extends = "b"\n'); w(tmp_path / "b.toml", 'extends = "a"\n')
    with pytest.raises(ValueError):
        build_tree("a", [tmp_path])
