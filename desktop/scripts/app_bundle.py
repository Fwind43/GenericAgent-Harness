"""Build the code-only update package for a release.

    python desktop/scripts/app_bundle.py <version> <out-dir>

Writes <out-dir>/ga-harness-app-<version>.zip (roots: ga_harness/ and genericagent/, the
same file set as scripts/prepare.mjs stages) and <out-dir>/update.json, read by
desktop/src/updater.js. genericagent/ is the GA source pinned in desktop/GA_REF, so GA
updates ride along with code packages.
min_shell comes from desktop/MIN_SHELL: bump it whenever a release needs a newer desktop
shell (Electron side, bundled Python, backend.js launch contract) -- including when the
pinned GA adds Python dependencies, which only a reinstall puts into the bundled Python;
otherwise desktop users get the small code update instead of a reinstall.
"""
import hashlib
import json
import sys
import tempfile
import zipfile
from pathlib import Path

SKIP_DIRS = {"__pycache__", ".pytest_cache", "node_modules", "sessions"}

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_ga  # noqa: E402


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
        with tempfile.TemporaryDirectory() as tmp:
            ga, _ = fetch_ga.fetch(tmp)
            for path in sorted(ga.rglob("*")):
                if path.is_file():
                    zf.write(path, path.relative_to(tmp).as_posix())
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
