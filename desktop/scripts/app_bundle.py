"""Build the code-only update package for a release.

    python desktop/scripts/app_bundle.py <version> <out-dir>

Writes <out-dir>/ga-harness-app-<version>.zip (root: ga_harness/, same file set as
scripts/prepare.mjs stages) and <out-dir>/update.json, read by desktop/src/updater.js.
min_shell comes from desktop/MIN_SHELL: bump it whenever a release needs a newer desktop
shell (Electron side, bundled Python, backend.js launch contract); otherwise desktop
users get the small code update instead of a reinstall.
"""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

SKIP_DIRS = {"__pycache__", ".pytest_cache", "node_modules", "sessions"}


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
    min_shell = (desktop / "MIN_SHELL").read_text(encoding="utf-8").strip() or "0.0.0"
    info = {
        "version": version,
        "min_shell": min_shell,
        "app": {"file": name, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)},
    }
    (out / "update.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(info))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], Path(sys.argv[2]))
