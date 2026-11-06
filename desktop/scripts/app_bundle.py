"""Build the code-only update package for a release.

    python desktop/scripts/app_bundle.py <version> <out-dir>

Writes <out-dir>/ga-harness-app-<version>.zip (root: ga_harness/) and <out-dir>/update.json,
read by desktop/src/updater.js. GenericAgent is excluded so updates never overwrite the user's
local GenericAgent directory (which may hold custom optimizations or Agent-managed updates).
Shell requirements come from desktop/shell.json, per platform:
  required     below it the code package is not applied and a reinstall is needed. Raise it
               only when the code cannot run on older shells (backend.js launch contract,
               bundled Python or its dependencies -- including Python deps the pinned GA adds)
               and only for the platforms affected.
  recommended  older shells still take the small code update and only get an optional hint.
update.json carries them as "shell": {"required": {...}, "recommended": {...}}, plus the legacy
"min_shell" (highest required version over all platforms) for shells that predate "shell".
"""
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

SKIP_DIRS = {"__pycache__", ".pytest_cache", "node_modules", "sessions"}

PLATFORMS = ("win32", "darwin", "linux")


def _vkey(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3])


def shell_requirements(desktop: Path) -> dict:
    data = json.loads((desktop / "shell.json").read_text(encoding="utf-8"))
    out = {}
    for field in ("required", "recommended"):
        table = data.get(field) or {}
        unknown = set(table) - set(PLATFORMS)
        if unknown:
            sys.exit(f"shell.json {field}: unknown platform(s) {sorted(unknown)}")
        out[field] = {p: str(table.get(p) or "0.0.0") for p in PLATFORMS}
    for p in PLATFORMS:   # a recommendation below the requirement means nothing
        if _vkey(out["recommended"][p]) < _vkey(out["required"][p]):
            out["recommended"][p] = out["required"][p]
    return out


def main(version: str, out: Path) -> None:
    desktop = Path(__file__).resolve().parents[1]
    repo = desktop.parent
    pkg = repo / "ga_harness"
    if not (pkg / "plugins" / "ui-web" / "dist" / "index.html").is_file():
        sys.exit("ui-web dist missing: run `npm run build` in frontend/ first")
    out.mkdir(parents=True, exist_ok=True)
    name = f"ga-harness-app-{version}.zip"
    target = out / name
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in sorted(pkg.rglob("*")):
            rel = path.relative_to(repo)
            if any(part in SKIP_DIRS for part in rel.parts) or path.suffix == ".pyc" or not path.is_file():
                continue
            zf.write(path, rel.as_posix())
    data = target.read_bytes()
    shell = shell_requirements(desktop)
    info = {
        "version": version,
        # Shells older than the per-platform "shell" field only read this one.
        "min_shell": max(shell["required"].values(), key=_vkey),
        "shell": shell,
        "app": {"file": name, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)},
    }
    (out / "update.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(info))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], Path(sys.argv[2]))
