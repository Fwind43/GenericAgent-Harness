"""web-sidebar: a right-hand workbench for ui-web -- file tree, file viewer/editor and Git changes.

Everything is fenced to a selected browsing root, independently of the chat's execution cwd.
All endpoints accept ``root=auto|workspace|project`` and an optional ``project_id`` (project mode only).
Auto uses the project's memory directory when its default workspace is blank and the chat has no
workspace override; otherwise it uses the workspace of ``sid`` (the current chat when absent).

GET  /api/p/web-sidebar/tree?sid=&path=DIR   -> {root, path, git, entries: [{name, type, size, status}], truncated}
GET  /api/p/web-sidebar/file?sid=&path=FILE  -> {path, abs, kind: text|image|binary, size, mtime, text, eol, bom, truncated}
POST /api/p/web-sidebar/file {sid, path, text, mtime, eol, bom} -> {path, size, mtime}   (409 when changed on disk)
GET  /api/p/web-sidebar/search?sid=&q=TEXT   -> {files: [path], truncated}
GET  /api/p/web-sidebar/git?sid=             -> {git, branch, files: [{path, status}]}
GET  /api/p/web-sidebar/diff?sid=&path=FILE  -> {path, diff, truncated}

Inspired by omdsh-dev/DSH-better-sidebar (MIT); see NOTICE.md. Written for GA Harness, no code shared.
"""
import os
import subprocess
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

TEXT_LIMIT = 1 << 20          # largest file opened (and saved) as text
DIFF_LIMIT = 400_000
LIST_LIMIT = 2000
SEARCH_LIMIT = 200
SEARCH_SCAN = 40_000
SEARCH_SECONDS = 2.0
GIT_TIMEOUT = 8
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", "dist", "build", ".next", "target"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg", ".avif"}
BOM = b"\xef\xbb\xbf"


class Fence(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def inside(root, rel, must_exist=True):
    """Resolve ``rel`` under ``root``; symlinks that leave the workspace are refused."""
    rel = str(rel or "").replace("\\", "/").strip("/")
    if "\x00" in rel or any(part == ".." for part in rel.split("/")):
        raise Fence(400, "invalid path")
    root = Path(os.path.realpath(root))
    target = Path(os.path.realpath(root / rel)) if rel else root
    if target != root and root not in target.parents:
        raise Fence(403, "path is outside the workspace")
    if must_exist and not target.exists():
        raise Fence(404, "not found")
    return root, target


def relpath(root, target):
    return "" if target == root else target.relative_to(root).as_posix()


def git(cwd, *args, ok=(0,)):
    """Run a read-only git command; None when git is missing, times out or fails."""
    cmd = ["git", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-C", str(cwd), *args]
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        done = subprocess.run(cmd, capture_output=True, timeout=GIT_TIMEOUT, env=env, creationflags=flags)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout if done.returncode in ok else None


def git_top(root):
    out = git(root, "rev-parse", "--show-toplevel")
    top = out.decode("utf-8", "replace").strip() if out else ""
    return Path(os.path.realpath(top)) if top else None


def git_status(root):
    """{workspace-relative path: status letter} for the repository containing ``root``, or None.

    An untracked directory is reported once, with a trailing slash.
    """
    top = git_top(root)
    if top is None:
        return None
    out = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", ".")
    if out is None:
        return None
    result, parts, i = {}, out.decode("utf-8", "replace").split("\0"), 0
    while i < len(parts):
        item = parts[i]
        i += 1
        if len(item) < 4:
            continue
        x, y, name = item[0], item[1], item[3:]
        if x in "RC":
            i += 1  # the original path follows a rename/copy
        if x == "?":
            code = "?"
        elif "U" in (x, y) or (x == y and x in "AD"):
            code = "U"
        else:
            code = x if x != " " else y
        target = Path(os.path.realpath(top / name.rstrip("/")))
        if target == root or root in target.parents:
            result[relpath(root, target) + ("/" if name.endswith("/") else "")] = code
    return result


def dir_status(status, rel):
    """Status letter for a directory: its own (untracked dir) or 'M' when anything below changed."""
    prefix = rel + "/"
    if prefix in status:
        return status[prefix]
    return "M" if any(key.startswith(prefix) for key in status) else ""


def under_untracked(status, rel):
    return next((code for key, code in status.items() if key.endswith("/") and (rel + "/").startswith(key)), "")


def list_dir(root, target, status):
    entries, truncated = [], False
    base = relpath(root, target)
    try:
        with os.scandir(target) as it:
            rows = sorted(it, key=lambda e: (not e.is_dir(), e.name.lower()))
    except OSError as e:
        raise Fence(403, f"cannot read directory: {e.strerror or e}")
    for entry in rows:
        if entry.name == ".git":
            continue
        if len(entries) >= LIST_LIMIT:
            truncated = True
            break
        rel = f"{base}/{entry.name}" if base else entry.name
        is_dir = entry.is_dir()
        try:
            size = 0 if is_dir else entry.stat().st_size
        except OSError:
            size = 0
        code = ""
        if status:
            code = (dir_status(status, rel) if is_dir else status.get(rel, "")) or under_untracked(status, rel)
        entries.append({"name": entry.name, "type": "dir" if is_dir else "file", "size": size, "status": code})
    return entries, truncated


def read_file(root, target):
    st = target.stat()
    out = {"path": relpath(root, target), "abs": str(target), "size": st.st_size, "mtime": str(st.st_mtime_ns),
           "kind": "binary", "text": "", "eol": "\n", "bom": False, "truncated": False}
    if target.suffix.lower() in IMAGE_EXT:
        out["kind"] = "image"
        return out
    with open(target, "rb") as fh:
        data = fh.read(TEXT_LIMIT + 1)
    if b"\x00" in data[:8192]:
        return out
    out["truncated"] = len(data) > TEXT_LIMIT
    out["bom"] = data.startswith(BOM)
    body = data[len(BOM) if out["bom"] else 0:TEXT_LIMIT]
    try:
        text = body.decode("utf-8", "ignore" if out["truncated"] else "strict")
    except UnicodeDecodeError:
        return out
    out["eol"] = "\r\n" if "\r\n" in text else "\n"
    out.update(kind="text", text=text.replace("\r\n", "\n"))
    return out


def write_file(root, target, text, mtime, eol="\n", bom=False):
    if ".git" in target.relative_to(root).parts:
        raise Fence(403, "refusing to write inside .git")
    if not target.is_file():
        raise Fence(404, "not a file")
    before = target.stat()
    if str(before.st_mtime_ns) != str(mtime):
        raise Fence(409, "file changed on disk; reload before saving")
    data = text.replace("\r\n", "\n")
    if eol == "\r\n":
        data = data.replace("\n", "\r\n")
    data = (BOM if bom else b"") + data.encode("utf-8")
    if len(data) > TEXT_LIMIT:
        raise Fence(413, "file too large to save")
    fd, tmp = tempfile.mkstemp(prefix=".gah-", suffix=".tmp", dir=str(target.parent))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        try:
            os.chmod(tmp, before.st_mode & 0o7777)
        except OSError:
            pass
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    st = target.stat()
    return {"path": relpath(root, target), "size": st.st_size, "mtime": str(st.st_mtime_ns)}


def search(root, query):
    words = [w for w in query.lower().split() if w]
    files, scanned, deadline = [], 0, time.monotonic() + SEARCH_SECONDS
    if not words:
        return files, False
    for base, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        prefix = relpath(root, Path(base))
        for name in sorted(names):
            scanned += 1
            rel = f"{prefix}/{name}" if prefix else name
            low = rel.lower()
            if all(w in low for w in words):
                files.append(rel)
            if len(files) >= SEARCH_LIMIT or scanned >= SEARCH_SCAN or time.monotonic() > deadline:
                return files, True
    return files, False


def diff(root, target, status):
    rel = relpath(root, target)
    code = status.get(rel, "") or under_untracked(status, rel)
    common = ("--no-color", "--no-ext-diff", "--no-textconv")
    if code == "?":
        out = git(root, "diff", *common, "--no-index", "--", os.devnull, str(target), ok=(0, 1))
    else:
        out = git(root, "diff", *common, "HEAD", "--", str(target))
        if out is None:  # no commit yet
            out = git(root, "diff", *common, "--cached", "--", str(target))
    if out is None:
        raise Fence(502, "git diff failed")
    return {"path": rel, "diff": out[:DIFF_LIMIT].decode("utf-8", "replace"), "truncated": len(out) > DIFF_LIMIT}


def apply(ctx, config):
    host = ctx.get("web.host")

    def workspace(req, source="query"):
        workspaces, sessions = ctx.get("workspaces"), ctx.get("sessions")
        if workspaces is None or sessions is None:
            raise Fence(503, "workspaces are not enabled")
        params = req.get(source) or {}
        sid = str(params.get("sid") or "")
        mode = params.get("root") or "auto"
        pid = str(params.get("project_id") or "")
        if mode not in ("auto", "workspace", "project") or (pid and mode != "project"):
            raise Fence(400, "invalid browsing root")
        try:
            context = workspaces.context(sid or sessions.current()["id"])
        except (ValueError, KeyError, TypeError) as e:
            raise Fence(404, f"session not found: {e}")
        project = context.get("project")
        if pid:
            project = next((p for p in workspaces.projects() if p["id"] == pid), None)
        if mode == "auto":
            # Keep an explicitly chosen chat workspace, even for a project with no default.
            use_project = (project and not project.get("workspace") and workspaces.projects_root is not None
                           and Path(context["workspace"]).resolve() == Path(workspaces.default_workspace).resolve())
            mode = "project" if use_project else "workspace"
        if mode == "project":
            if project is None:
                raise Fence(404, "project not found")
            if workspaces.projects_root is None:
                raise Fence(404, "project directory is not configured")
            root = (workspaces.projects_root / project["name"]).resolve()
            if not root.is_relative_to(workspaces.projects_root.resolve()):
                raise Fence(403, "project directory is outside the projects root")
        else:
            root = Path(context["workspace"]).resolve()
        if not root.is_dir():
            raise Fence(404, f"{mode} directory does not exist")
        return str(root)

    def guarded(fn):
        def run(req):
            try:
                return fn(req)
            except Fence as e:
                return e.code, {"error": str(e)}
            except OSError as e:
                return 500, {"error": e.strerror or str(e)}
        return run

    def tree(req):
        root, target = inside(workspace(req), req["query"].get("path"))
        if not target.is_dir():
            raise Fence(400, "not a directory")
        status = git_status(root)
        entries, truncated = list_dir(root, target, status)
        return {"root": str(root), "path": relpath(root, target), "git": status is not None,
                "entries": entries, "truncated": truncated}

    def file_get(req):
        root, target = inside(workspace(req), req["query"].get("path"))
        if not target.is_file():
            raise Fence(400, "not a file")
        return read_file(root, target)

    def file_post(req):
        body = req.get("body") or {}
        text = body.get("text")
        if not isinstance(text, str):
            raise Fence(400, "text is required")
        root, target = inside(workspace(req, "body"), body.get("path"))
        return write_file(root, target, text, body.get("mtime"),
                          "\r\n" if body.get("eol") == "\r\n" else "\n", bool(body.get("bom")))

    def find(req):
        root, _ = inside(workspace(req), "")
        files, truncated = search(root, str(req["query"].get("q") or "")[:200])
        return {"files": files, "truncated": truncated}

    def changes(req):
        root, _ = inside(workspace(req), "")
        status = git_status(root)
        if status is None:
            return {"git": False, "branch": "", "files": []}
        branch = git(root, "symbolic-ref", "--short", "HEAD") or git(root, "rev-parse", "--short", "HEAD") or b""
        files = [{"path": key, "status": code} for key, code in sorted(status.items())]
        return {"git": True, "branch": branch.decode("utf-8", "replace").strip(), "files": files}

    def file_diff(req):
        root, target = inside(workspace(req), req["query"].get("path"), must_exist=False)
        status = git_status(root)
        if status is None:
            raise Fence(400, "not a git repository")
        return diff(root, target, status)

    routes = {("GET", "tree"): tree, ("GET", "file"): file_get, ("POST", "file"): file_post,
              ("GET", "search"): find, ("GET", "git"): changes, ("GET", "diff"): file_diff}
    ctx.scope.add(host.register("web-sidebar", script=HERE / "client.js", style=HERE / "client.css", order=60,
                                routes={key: guarded(fn) for key, fn in routes.items()}))
