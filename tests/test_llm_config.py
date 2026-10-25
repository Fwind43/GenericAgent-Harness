import importlib, sys, os
from pathlib import Path
import pytest
from ga_harness import llmconfig
from ga_harness.kernel import Runtime
from ga_harness.kernel.loader import discover, mount
from ga_harness.cli import PLUGIN_DIRS


def ga_style_import():
    # mirrors llmcore._load_mykeys
    sys.modules.pop("mykey", None)
    import mykey
    return mykey.__file__, {k: v for k, v in vars(mykey).items() if not k.startswith("_")}


@pytest.fixture(autouse=True)
def clean():
    yield
    for f in [f for f in sys.meta_path if isinstance(f, llmconfig.MykeyFinder)]:
        sys.meta_path.remove(f)
    sys.modules.pop("mykey", None)


def test_file_env_and_inline(tmp_path, monkeypatch):
    p = tmp_path / "llm.toml"
    p.write_text('proxy = "http://x"\n[native_oai_config]\nname = "a"\napikey = "${T_KEY}"\napibase = "${T_BASE:-http://d}"\n', encoding="utf-8")
    monkeypatch.setenv("T_KEY", "sk-secret-123456")
    f = llmconfig.install(llmconfig.Source(p, {"extra_api": {"name": "b"}}))
    path, d = ga_style_import()
    assert Path(path) == p
    assert d["native_oai_config"] == {"name": "a", "apikey": "sk-secret-123456", "apibase": "http://d"}
    assert d["extra_api"] == {"name": "b"} and d["proxy"] == "http://x"
    # hot reload: GA re-imports after mtime change
    p.write_text('[native_oai_config]\nname = "c"\napikey = "k"\n', encoding="utf-8")
    assert ga_style_import()[1]["native_oai_config"]["name"] == "c"
    llmconfig.uninstall(f)
    assert f not in sys.meta_path and "mykey" not in sys.modules


def test_missing_env_fails_fast(tmp_path, monkeypatch):
    monkeypatch.delenv("NOPE_X", raising=False)
    with pytest.raises(llmconfig.ConfigError, match="NOPE_X"):
        llmconfig.install(llmconfig.Source(None, {"a_config": {"apikey": "${NOPE_X}"}}))
    assert not any(isinstance(f, llmconfig.MykeyFinder) for f in sys.meta_path)


def test_plugin_lifecycle_and_fallback(tmp_path, monkeypatch):
    m = discover(PLUGIN_DIRS)
    rt = Runtime()
    mount(rt, [{"name": "llm-config", "config": {"keys": {"x_config": {"name": "n", "apikey": "secretvalue1"}}}, "disabled": False}], m)
    info = rt.ctx.get("llm.config")
    assert info["names"] == ["x_config"]
    assert ga_style_import()[1]["x_config"]["name"] == "n"
    rt.dispose()
    assert not any(isinstance(f, llmconfig.MykeyFinder) for f in sys.meta_path)
    # no source -> fallback, nothing installed
    monkeypatch.setenv("GAH_LLM_CONFIG", str(tmp_path / "absent.toml"))
    rt = Runtime()
    mount(rt, [{"name": "llm-config", "config": {}, "disabled": False}], m)
    assert rt.ctx.get("llm.config")["source"] is None
    assert not any(isinstance(f, llmconfig.MykeyFinder) for f in sys.meta_path)
    rt.dispose()


def test_migrate_roundtrip_and_mask(tmp_path):
    src = tmp_path / "mykey.py"
    src.write_text('import os\nproxy = "http://p"\nnative_claude_config = {"name": "c", "apikey": "sk-ant-abcdefghij", "max_retries": 3, "stream": True, "x": None}\nmixin_config = {"llm_nos": [0, 1], "max_retries": 2}\n_private = 1\n', encoding="utf-8")
    data = llmconfig.read_mykey_py(src)
    assert data.get("_skipped") == ["os"]
    data.pop("_skipped")
    out = tmp_path / "llm.toml"
    out.write_text(llmconfig.to_toml(data), encoding="utf-8")
    back = llmconfig.read_file(out)
    assert back["native_claude_config"] == {"name": "c", "apikey": "sk-ant-abcdefghij", "max_retries": 3, "stream": True}
    assert back["mixin_config"]["llm_nos"] == [0, 1] and back["proxy"] == "http://p"
    assert llmconfig.mask(back)["native_claude_config"]["apikey"] == "sk-***"


def test_group_providers_only_merges_identical_credentials(tmp_path):
    data = {
        "proxy": "http://p",
        "native_oai_config_a": {"name": "A", "model": "a", "apibase": "https://api.openai.com/v1", "apikey": "k1"},
        "native_oai_config_b": {"name": "B", "model": "b", "apibase": "https://api.openai.com/v1", "apikey": "k1",
                                "max_retries": 2},
        "native_oai_config_c": {"name": "C", "model": "c", "apibase": "https://api.openai.com/v1", "apikey": "k2"},
        "native_claude_config_d": {"name": "D", "model": "d", "apibase": "https://api.openai.com/v1", "apikey": "k1"},
        "native_oai_config_e": {"name": "E", "model": "e", "apibase": "https://relay.example.com/v1",
                                "apikey": "k1", "apikey_extra": "x"},
        "native_oai_config_nokey": {"name": "N", "model": "n", "apibase": "https://x.example.com/v1"},
        "mixin_config": {"llm_nos": [0, 1]},
    }
    out = llmconfig.group_providers(data)
    p = out[llmconfig.PROVIDERS]
    owner = {k: v.get("provider") for k, v in out.items() if isinstance(v, dict) and k != llmconfig.PROVIDERS}
    assert owner["native_oai_config_a"] == owner["native_oai_config_b"]
    assert len({owner[k] for k in ("native_oai_config_a", "native_oai_config_c", "native_claude_config_d",
                                   "native_oai_config_e")}) == 4   # different key / protocol never merge
    assert owner["native_oai_config_nokey"] is None and owner["mixin_config"] is None
    assert owner["native_oai_config_a"] == "openai" and owner["native_oai_config_e"] == "relay-example"
    assert p["openai"] == {"name": p["openai"]["name"], "protocol": "oai",
                           "apibase": "https://api.openai.com/v1", "apikey": "k1"}
    assert p[owner["native_claude_config_d"]]["protocol"] == "claude"
    assert len({v["name"] for v in p.values()}) == len(p)
    assert "apikey" not in out["native_oai_config_a"] and out["native_oai_config_b"]["max_retries"] == 2
    assert llmconfig.resolve_providers(out) == data
    f = tmp_path / "llm.toml"
    f.write_text(llmconfig.to_toml(out), encoding="utf-8")
    assert "[providers.openai]" in f.read_text(encoding="utf-8")
    assert llmconfig.Source(f).load() == llmconfig.Source(inline=data).load()
    assert llmconfig.group_providers(out) is out   # already grouped: untouched
    assert llmconfig.group_providers({"proxy": "x"}) == {"proxy": "x"}


def test_cli_migrate_and_show(tmp_path, capsys):
    from ga_harness.cli import main
    src = tmp_path / "mykey.py"
    src.write_text('a_config = {"name": "n", "apikey": "sk-1234567890"}\n', encoding="utf-8")
    out = tmp_path / "llm.toml"
    assert main(["llm", "migrate", str(src), "--out", str(out)]) == 0
    assert main(["llm", "migrate", str(src), "--out", str(out)]) == 1   # no clobber
    assert main(["llm", "show", "--file", str(out)]) == 0
    o = capsys.readouterr().out
    assert "sk-***" in o and "sk-1234567890" not in o.split("wrote")[-1].split("\n", 1)[1]
