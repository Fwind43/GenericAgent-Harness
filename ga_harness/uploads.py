"""Composer attachments: files uploaded from the web UI for a run.

Files are stored under ``~/.ga-harness/uploads/<YYYYMMDD>/<id>_<name>``. A run
references them by the descriptor returned from ``save`` ({id, name, path, mime,
size, image}); ``resolve`` re-validates descriptors coming back from the client so
a request can never point the agent at an arbitrary file outside the upload root.
"""
from __future__ import annotations

import mimetypes
import re
import time
import uuid
from pathlib import Path

ROOT = Path.home() / ".ga-harness" / "uploads"
MAX_FILE = 50 << 20            # per-file limit
MAX_FILES = 20                 # per message
# Formats every vision-capable GA backend accepts as an inline image block.
VISION_MIMES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
_UNSAFE = re.compile(r'[\x00-\x1f<>:"/\\|?*]+')
_ID = re.compile(r"^[0-9a-f]{32}$")


def safe_name(name) -> str:
    name = _UNSAFE.sub("_", str(name or "").strip()).strip(" .") or "file"
    if len(name) > 120:
        stem, dot, ext = name.rpartition(".")
        name = (stem[:100] + dot + ext[:15]) if dot and len(ext) <= 15 else name[:120]
    return name


def guess_mime(name: str, declared: str | None = None) -> str:
    declared = (declared or "").split(";", 1)[0].strip().lower()
    if declared and declared != "application/octet-stream":
        return declared
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def describe(path: Path, mime: str | None = None) -> dict:
    fid, _, name = path.name.partition("_")
    mime = mime or guess_mime(name)
    return {"id": fid, "name": name, "path": str(path), "mime": mime,
            "size": path.stat().st_size, "image": mime in VISION_MIMES,
            "url": "/api/upload/" + path.parent.name + "/" + path.name}


def save(stream, length: int, name, declared_mime=None, root: Path | None = None) -> dict:
    """Copy exactly ``length`` bytes from ``stream`` into a new upload file."""
    if length <= 0:
        raise ValueError("empty file")
    if length > MAX_FILE:
        raise OverflowError("file too large")
    name = safe_name(name)
    folder = (root or ROOT) / time.strftime("%Y%m%d")
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{uuid.uuid4().hex}_{name}"
    left = length
    try:
        with open(path, "wb") as out:
            while left:
                chunk = stream.read(min(left, 1 << 20))
                if not chunk:
                    raise ValueError("upload truncated")
                out.write(chunk)
                left -= len(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return describe(path, guess_mime(name, declared_mime))


def locate(rel: str, root: Path | None = None) -> Path | None:
    """Map ``<day>/<file>`` from a URL to a stored upload, or None."""
    base = (root or ROOT).resolve()
    parts = rel.split("/")
    if len(parts) != 2 or not parts[0].isdigit() or not _ID.match(parts[1][:32]) or parts[1][32:33] != "_":
        return None
    path = (base / parts[0] / parts[1]).resolve()
    return path if path.is_relative_to(base) and path.is_file() else None


def resolve(items, root: Path | None = None) -> list[dict]:
    """Validate client-sent attachment descriptors against the upload store."""
    if items is None:
        return []
    if not isinstance(items, list) or len(items) > MAX_FILES:
        raise ValueError(f"attachments must be a list of at most {MAX_FILES} files")
    out = []
    for item in items:
        url = item.get("url") if isinstance(item, dict) else None
        path = locate(url.removeprefix("/api/upload/"), root) if isinstance(url, str) else None
        if path is None:
            raise ValueError("unknown attachment")
        out.append(describe(path, item.get("mime") if isinstance(item.get("mime"), str) else None))
    return out


def task_text(task: str, attachments: list[dict]) -> str:
    """The prompt GA receives: the user's text plus the local path of every file."""
    if not attachments:
        return task
    lines = [f"- {a['name']} ({a['mime']}, {a['size']} bytes): {a['path']}" for a in attachments]
    head = "[Attachments: images are also included inline; read files from these local paths]"
    return (task + "\n\n" if task else "") + head + "\n" + "\n".join(lines)


def image_paths(attachments: list[dict]) -> list[str]:
    return [a["path"] for a in attachments if a.get("image")]
