"""Import a user plugin from a zip archive or a git repository.

The source is unpacked/cloned into a private staging directory, the single
``plugin.toml`` inside is located and validated, and the plugin directory is
then moved into the user plugin directory as ``<plugins>/<name>``. Nothing is
imported or enabled here; the caller rescans so the plugin shows up disabled.
"""
from __future__ import annotations

import io
import os
import re
import shutil
import stat
import subprocess
import tempfile
import tomllib
import zipfile
from pathlib import Path, PurePosixPath

MAX_ZIP = 50 << 20          # uploaded archive size
MAX_UNPACKED = 200 << 20    # total uncompressed size
MAX_ENTRIES = 5000
GIT_TIMEOUT = 180
NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
# Only network transports; blocks file://, local paths and git's ext:: helper.
GIT_URL = re.compile(r"^(https?://|ssh://|git://|[\w.-]+@[\w.-]+:)[^\s]+$")
SKIP = {".git", "__pycache__", "node_modules"}


class PluginImportError(ValueError):
    """Rejected source (shown to the user as-is)."""


def _rmtree(path):
    def onerror(func, p, _exc):  # read-only files inside .git on Windows
        os.chmod(p, stat.S_IWRITE)
        func(p)
    shutil.rmtree(path, onerror=onerror)


def unpack_zip(data: bytes, dest: Path) -> None:
    if len(data) > MAX_ZIP:
        raise PluginImportError(f"archive is larger than {MAX_ZIP >> 20} MB")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise PluginImportError("not a valid zip archive") from None
    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_ENTRIES:
            raise PluginImportError("archive has too many entries")
        if sum(i.file_size for i in infos) > MAX_UNPACKED:
            raise PluginImportError(f"archive unpacks to more than {MAX_UNPACKED >> 20} MB")
        root = dest.resolve()
        for info in infos:
            name = info.filename.replace("\\", "/")
            parts = PurePosixPath(name).parts
            if name.startswith("/") or ".." in parts or (parts and ":" in parts[0]):
                raise PluginImportError(f"unsafe path in archive: {info.filename}")
            if stat.S_ISLNK(info.external_attr >> 16):
                raise PluginImportError(f"symbolic links are not allowed: {info.filename}")
            target = (root / name).resolve()
            if target != root and root not in target.parents:
                raise PluginImportError(f"unsafe path in archive: {info.filename}")
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


def clone_git(url: str, ref: str | None, dest: Path) -> None:
    url = (url or "").strip()
    if not GIT_URL.match(url) or url.startswith("-"):
        raise PluginImportError("git URL must use https://, ssh://, git:// or user@host:path")
    if ref and (ref.startswith("-") or not re.match(r"^[\w./-]{1,200}$", ref)):
        raise PluginImportError("invalid git branch or tag")
    if shutil.which("git") is None:
        raise PluginImportError("git is not installed or not on PATH")
    cmd = ["git", "clone", "--depth", "1", "--no-tags"]
    if ref:
        cmd += ["--branch", ref]
    cmd += ["--", url, str(dest)]
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_ALLOW_PROTOCOL": "https:http:ssh:git"}
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=GIT_TIMEOUT, env=env, stdin=subprocess.DEVNULL,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired:
        raise PluginImportError(f"git clone timed out after {GIT_TIMEOUT}s") from None
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "").strip().splitlines()[-3:]
        raise PluginImportError("git clone failed: " + (" ".join(tail) or f"exit {r.returncode}"))


def locate(root: Path, subdir: str | None = None) -> Path:
    """Directory holding the plugin's plugin.toml (root, a subdir, or a single wrapper dir)."""
    if subdir:
        parts = PurePosixPath(subdir.replace("\\", "/").strip("/")).parts
        if not parts or ".." in parts:
            raise PluginImportError("invalid sub-directory")
        root = root.joinpath(*parts)
        if not root.is_dir():
            raise PluginImportError(f"sub-directory not found: {subdir}")
    if (root / "plugin.toml").is_file():
        return root
    found = [p.parent for p in root.rglob("plugin.toml")
             if not SKIP.intersection(p.relative_to(root).parts)]
    if len(found) == 1:
        return found[0]
    if not found:
        raise PluginImportError("no plugin.toml found")
    names = ", ".join(sorted(str(p.relative_to(root)).replace("\\", "/") for p in found)[:8])
    raise PluginImportError(f"several plugins found ({names}); choose one with the sub-directory field")


def read_manifest(plugin_dir: Path) -> dict:
    try:
        data = tomllib.loads((plugin_dir / "plugin.toml").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as e:
        raise PluginImportError(f"plugin.toml is invalid: {e}") from None
    name = data.get("name")
    if not isinstance(name, str) or not NAME.match(name):
        raise PluginImportError("plugin.toml needs a name made of lowercase letters, digits, '.', '_' or '-'")
    entry = data.get("entry", "main:apply")
    if not isinstance(entry, str) or not entry.partition(":")[0]:
        raise PluginImportError("plugin.toml has an invalid entry")
    module = entry.partition(":")[0].replace(".", "/")
    if not ((plugin_dir / f"{module}.py").is_file() or (plugin_dir / module / "__init__.py").is_file()):
        raise PluginImportError(f"entry module not found: {module}.py")
    for key in ("inject", "provides", "packages", "workers"):
        if not isinstance(data.get(key, []), list):
            raise PluginImportError(f"plugin.toml field '{key}' must be a list")
    return data


def install(source: dict | bytes, dest_root: Path, *, reserved: set[str], replaceable: set[str],
            filename: str = "", replace: bool = False, subdir: str | None = None) -> dict:
    """Stage ``source`` and move the plugin into ``dest_root``.

    ``source`` is raw zip bytes or ``{"url", "ref"?, "subdir"?, "replace"?}`` for git; zip
    callers pass ``replace``/``subdir`` as keywords.
    ``reserved`` names may never be written (built-in plugins); an existing user
    plugin is only overwritten when ``replace`` is set and its name is in ``replaceable``.
    """
    dest_root = Path(dest_root)
    dest_root.mkdir(parents=True, exist_ok=True)
    opts = dict(source) if isinstance(source, dict) else {}
    opts.setdefault("replace", replace)
    if subdir:
        opts.setdefault("subdir", subdir)
    staging = Path(tempfile.mkdtemp(prefix=".import-", dir=dest_root))
    try:
        unpacked = staging / "src"
        unpacked.mkdir()
        if isinstance(source, (bytes, bytearray)):
            unpack_zip(bytes(source), unpacked)
            origin = {"type": "zip", "file": filename}
        else:
            unpacked.rmdir()
            clone_git(opts.get("url", ""), opts.get("ref") or None, unpacked)
            origin = {"type": "git", "url": opts.get("url"), "ref": opts.get("ref") or None}
        plugin_dir = locate(unpacked, opts.get("subdir") or None)
        data = read_manifest(plugin_dir)
        name = data["name"]
        if name in reserved:
            raise PluginImportError(f"'{name}' is a built-in plugin and cannot be replaced")
        target = dest_root / name
        replaced = target.exists()
        if replaced:
            if not opts.get("replace"):
                raise FileExistsError(f"plugin '{name}' already exists")
            if name not in replaceable:
                raise PluginImportError(f"disable '{name}' before replacing it")
        for skip in SKIP:
            for p in list(plugin_dir.rglob(skip)):
                if p.is_dir():
                    _rmtree(p)
        if replaced:
            old = staging / "old"
            os.replace(target, old)
        try:
            shutil.move(str(plugin_dir), str(target))
        except Exception:
            if replaced:
                os.replace(staging / "old", target)
            raise
        return {"name": name, "path": str(target), "replaced": replaced, "source": origin,
                "packages": [str(x) for x in data.get("packages", []) or []]}
    finally:
        _rmtree(staging)
