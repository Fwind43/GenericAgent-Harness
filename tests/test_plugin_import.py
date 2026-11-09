import io
import zipfile

import pytest

from ga_harness import plugin_import as pi

MANIFEST = 'name = "{name}"\nentry = "main:apply"\n'


def _zip(files: dict[str, str | bytes], symlink: str | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data)
        if symlink:
            info = zipfile.ZipInfo(symlink)
            info.external_attr = (0o120777 << 16)
            zf.writestr(info, "target")
    return buf.getvalue()


def _plugin(name="demo", prefix=""):
    return {f"{prefix}plugin.toml": MANIFEST.format(name=name), f"{prefix}main.py": "def apply(app):\n    pass\n"}


def _install(data, root, **kw):
    kw.setdefault("reserved", set())
    kw.setdefault("replaceable", set())
    return pi.install(data, root, filename="p.zip", **kw)


def test_zip_with_wrapper_dir_installs_plugin(tmp_path):
    files = {**_plugin(prefix="demo-main/"), "demo-main/__pycache__/x.pyc": b"x"}
    out = _install(_zip(files), tmp_path)
    assert out["name"] == "demo" and out["replaced"] is False
    assert (tmp_path / "demo" / "plugin.toml").is_file()
    assert not (tmp_path / "demo" / "__pycache__").exists()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["demo"]  # staging removed


@pytest.mark.parametrize("bad", ["../evil.py", "/abs.py", "C:/x.py"])
def test_zip_rejects_unsafe_paths(tmp_path, bad):
    with pytest.raises(pi.PluginImportError):
        _install(_zip({**_plugin(), bad: "x"}), tmp_path / "plugins")
    assert not (tmp_path / "evil.py").exists()


def test_zip_rejects_symlinks_and_garbage(tmp_path):
    with pytest.raises(pi.PluginImportError, match="symbolic"):
        _install(_zip(_plugin(), symlink="link"), tmp_path)
    with pytest.raises(pi.PluginImportError, match="zip"):
        _install(b"not a zip", tmp_path)


def test_manifest_validation(tmp_path):
    with pytest.raises(pi.PluginImportError, match="no plugin.toml"):
        _install(_zip({"readme.md": "x"}), tmp_path)
    with pytest.raises(pi.PluginImportError, match="invalid"):
        _install(_zip({"plugin.toml": "name = ", "main.py": ""}), tmp_path)
    with pytest.raises(pi.PluginImportError, match="name"):
        _install(_zip({"plugin.toml": 'name = "Bad Name"', "main.py": ""}), tmp_path)
    with pytest.raises(pi.PluginImportError, match="entry module"):
        _install(_zip({"plugin.toml": 'name = "demo"'}), tmp_path)


def test_several_plugins_need_subdir(tmp_path):
    data = _zip({**_plugin("a", "a/"), **_plugin("b", "b/")})
    with pytest.raises(pi.PluginImportError, match="several"):
        _install(data, tmp_path)
    assert _install(data, tmp_path, subdir="b")["name"] == "b"


def test_replace_rules(tmp_path):
    data = _zip(_plugin())
    with pytest.raises(pi.PluginImportError, match="built-in"):
        _install(data, tmp_path, reserved={"demo"})
    _install(data, tmp_path)
    with pytest.raises(FileExistsError):
        _install(data, tmp_path)
    with pytest.raises(pi.PluginImportError, match="disable"):
        _install(data, tmp_path, replace=True)
    out = _install(_zip({**_plugin(), "extra.txt": "new"}), tmp_path, replace=True, replaceable={"demo"})
    assert out["replaced"] is True and (tmp_path / "demo" / "extra.txt").read_text() == "new"


@pytest.mark.parametrize("url", ["file:///tmp/x", "C:/repo", "-u", "ext::sh -c x", "../repo"])
def test_git_rejects_local_and_unsafe_urls(tmp_path, url):
    with pytest.raises(pi.PluginImportError, match="git URL"):
        _install({"url": url}, tmp_path)


def test_git_rejects_option_refs(tmp_path):
    with pytest.raises(pi.PluginImportError, match="branch"):
        _install({"url": "https://example.com/x.git", "ref": "--upload-pack=x"}, tmp_path)
