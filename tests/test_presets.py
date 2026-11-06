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
    assert "# [GA-Harness Plugin & Mode Development SOP]" in prompt
    assert "window.GAH.defineReact" in prompt
    assert "plugin_control" in prompt


def test_preset_prompt_file_and_traversal_guard(tmp_path):
    (tmp_path / "sop.md").write_text("SOP at {data_dir}/plugins/<name>/", encoding="utf-8")
    (tmp_path / "m.toml").write_text(
        'name = "M"\nprompt = "Header"\nprompt_file = "sop.md"\n',
        encoding="utf-8",
    )
    loaded = presets._parse(tmp_path / "m.toml")
    assert loaded["prompt"] == "Header\n\nSOP at {data_dir}/plugins/<name>/"

    (tmp_path / "bad.toml").write_text('name = "Bad"\nprompt_file = "../outside.md"\n', encoding="utf-8")
    try:
        presets._parse(tmp_path / "bad.toml")
    except ValueError as exc:
        assert "preset directory" in str(exc)
    else:
        raise AssertionError("expected ValueError for escaping prompt_file")


def test_prompt_without_placeholder_is_unchanged(tmp_path, monkeypatch):
    monkeypatch.setenv("GAH_HOME", str(tmp_path))
    preset = {"id": "x", "prompt": "plain {other} text", "disable_tools": [], "config": {}}
    recipe = presets.apply(_recipe(), preset)
    assert dict((m.name, c) for m, c in recipe)["ga-prompt"]["append"] == "plain {other} text"
