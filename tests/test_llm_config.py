"""Pure helpers kept for native mykey.py provider grouping."""
from ga_harness import llmconfig


def test_group_providers_only_merges_identical_credentials():
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
                                   "native_oai_config_e")}) == 3   # different base URL or key never merge
    assert owner["native_oai_config_nokey"] is None and owner["mixin_config"] is None
    assert owner["native_oai_config_a"] == "openai" and owner["native_oai_config_e"] == "relay-example"
    assert p["openai"] == {"name": p["openai"]["name"], "protocol": "oai",
                           "apibase": "https://api.openai.com/v1", "apikey": "k1"}
    assert owner["native_claude_config_d"] == owner["native_oai_config_a"]
    assert len({v["name"] for v in p.values()}) == len(p)
    assert "apikey" not in out["native_oai_config_a"] and out["native_oai_config_b"]["max_retries"] == 2
    assert llmconfig.resolve_providers(out) == data
    assert llmconfig.group_providers(out) is out   # already grouped: untouched
    assert llmconfig.group_providers({"proxy": "x"}) == {"proxy": "x"}
