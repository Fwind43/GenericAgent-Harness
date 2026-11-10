"""Plugin market listing: synthetic GitHub responses only, no network."""
import pytest

from ga_harness import plugin_market


def _repo(full="alice/gah-plugin-demo", **extra):
    owner, name = full.split("/")
    return {"full_name": full, "name": name, "owner": {"login": owner}, "html_url": "https://github.com/" + full,
            "description": "demo", "stargazers_count": 3, "pushed_at": "2026-01-02T03:04:05Z",
            "default_branch": "main", "license": {"spdx_id": "MIT"}, **extra}


@pytest.fixture(autouse=True)
def _clean_cache():
    plugin_market.reset_cache()
    yield
    plugin_market.reset_cache()


def test_search_maps_fields_and_queries_topic():
    seen = []

    def fetch(url):
        seen.append(url)
        return {"items": [_repo()]}

    out = plugin_market.search(fetch=fetch)
    assert "topic%3Aga-harness-plugin" in seen[0] and seen[0].startswith("https://api.github.com/")
    assert out["topic"] == "ga-harness-plugin" and out["cached"] is False
    assert out["items"] == [{
        "full_name": "alice/gah-plugin-demo", "name": "gah-plugin-demo", "owner": "alice", "description": "demo",
        "url": "https://github.com/alice/gah-plugin-demo", "clone_url": "https://github.com/alice/gah-plugin-demo.git",
        "stars": 3, "updated_at": "2026-01-02T03:04:05Z", "default_branch": "main", "license": "MIT", "fork": False,
    }]


def test_search_drops_unusable_entries():
    items = [
        _repo("a/private", private=True), _repo("a/archived", archived=True), _repo("a/disabled", disabled=True),
        {**_repo("a/elsewhere"), "html_url": "https://evil.example/a/elsewhere"},
        {"full_name": None}, "junk", _repo("a/ok", description=None, license=None),
    ]
    out = plugin_market.search(fetch=lambda url: {"items": items})
    assert [i["full_name"] for i in out["items"]] == ["a/ok"]
    assert out["items"][0]["description"] == "" and out["items"][0]["license"] == ""


def test_search_caches_until_ttl_or_refresh():
    calls, clock = [], [1000.0]

    def fetch(url):
        calls.append(url)
        return {"items": [_repo()]}

    now = lambda: clock[0]
    assert plugin_market.search(fetch=fetch, now=now)["cached"] is False
    assert plugin_market.search(fetch=fetch, now=now)["cached"] is True
    assert len(calls) == 1
    plugin_market.search(refresh=True, fetch=fetch, now=now)
    assert len(calls) == 2
    clock[0] += plugin_market.TTL + 1
    assert plugin_market.search(fetch=fetch, now=now)["cached"] is False
    assert len(calls) == 3


def test_search_rejects_unexpected_response_and_keeps_errors_uncached():
    with pytest.raises(plugin_market.MarketError):
        plugin_market.search(fetch=lambda url: {"message": "nope"})

    def boom(url):
        raise plugin_market.MarketError("GitHub rate limit reached; try again in a few minutes")

    with pytest.raises(plugin_market.MarketError):
        plugin_market.search(fetch=boom)
    assert plugin_market.search(fetch=lambda url: {"items": []})["items"] == []


def test_search_enriches_plugin_toml_and_readme_when_available():
    files = {
        ("alice/gah-plugin-demo", "main", "plugin.toml"): (
            'name = "ds-toolcall-guard"\n'
            'version = "0.2.0"\n'
            'category = "extension"\n'
            'description = "Recover XML tool calls"\n'
            'description_zh = "\\u4fee\\u590d DeepSeek \\u5de5\\u5177\\u8c03\\u7528"\n'
            'requires = ["ga-hooks"]\n'
            'provides = ["toolcall-guard"]\n'
            'packages = ["lxml"]\n'
        ),
        ("alice/gah-plugin-demo", "main", "README.md"): "# ds-toolcall-guard\n\nFixes malformed tool calls.\n",
    }
    out = plugin_market.search(
        fetch=lambda url: {"items": [_repo(description="")]},
        fetch_raw=lambda full, branch, path: files.get((full, branch, path)),
    )
    item = out["items"][0]
    assert item["plugin_name"] == "ds-toolcall-guard"
    assert item["version"] == "0.2.0"
    assert item["category"] == "extension"
    assert item["description"] == "Recover XML tool calls"
    assert item["description_zh"] == "\u4fee\u590d DeepSeek \u5de5\u5177\u8c03\u7528"
    assert item["requires"] == ["ga-hooks"]
    assert item["provides"] == ["toolcall-guard"]
    assert item["packages"] == ["lxml"]
    assert "Fixes malformed tool calls." in item["readme"]

