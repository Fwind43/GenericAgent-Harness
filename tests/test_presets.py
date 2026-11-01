from types import SimpleNamespace

from ga_harness import presets


def _recipe():
    return [(SimpleNamespace(name="ga-prompt"), {"append": ""}),
            (SimpleNamespace(name="ga-tools"), {})]


def test_creative_prompt_names_the_actual_data_dir(tmp_path, monkeypatch):
    home = tmp_path / "portable-data"
    monkeypatch.setenv("GAH_HOME", str(home))
    creative = presets._parse(presets.BUILTIN_DIR / "creative.toml")
    assert "{data_dir}" in creative["prompt"]
    assert "~/.ga-harness" not in creative["prompt"]
    recipe = presets.apply(_recipe(), creative)
    prompt = dict((m.name, c) for m, c in recipe)["ga-prompt"]["append"]
    root = str(home.resolve())
    assert "{data_dir}" not in prompt
    assert f"{root}/plugins/" in prompt and f"{root}/presets/" in prompt


def test_prompt_without_placeholder_is_unchanged(tmp_path, monkeypatch):
    monkeypatch.setenv("GAH_HOME", str(tmp_path))
    preset = {"id": "x", "prompt": "plain {other} text", "disable_tools": [], "config": {}}
    recipe = presets.apply(_recipe(), preset)
    assert dict((m.name, c) for m, c in recipe)["ga-prompt"]["append"] == "plain {other} text"
