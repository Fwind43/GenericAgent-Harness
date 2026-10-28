"""Fetch the pinned GenericAgent source (desktop/GA_REF) for bundling.

    python desktop/scripts/fetch_ga.py <dest-dir> [--requirements <file>]

Writes <dest-dir>/genericagent/ (agentmain.py at its root) plus .gah-ga-ref holding the
commit, which the desktop shell compares to decide whether to refresh the user's copy.
Demo media and the PDF report are left out. --requirements writes GA's core
[project].dependencies, one per line, for installing into the bundled Python.
GAH_GA_SOURCE=<local checkout> copies that checkout instead of downloading (offline builds).
"""
import io
import os
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

DESKTOP = Path(__file__).resolve().parents[1]
NAME = "genericagent"
REF_FILE = ".gah-ga-ref"
SKIP_PREFIXES = ("assets/demo/", "assets/images/", ".github/")
SKIP_SUFFIXES = (".pdf", ".pyc")
SKIP_PARTS = {"__pycache__", ".git"}
# GA keeps user state next to its code; a source checkout must not leak it into the bundle.
SKIP_TOP = {"mykey.py", "temp", ".venv"}


def read_pin():
    pin = {}
    for line in (DESKTOP / "GA_REF").read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if "=" in line:
            k, v = (s.strip() for s in line.split("=", 1))
            pin[k] = v
    if not pin.get("repo") or not pin.get("ref"):
        sys.exit("desktop/GA_REF needs `repo = owner/name` and `ref = <commit>`")
    return pin["repo"], pin["ref"]


def keep(rel):
    parts = rel.split("/")
    return not (parts[0] in SKIP_TOP or SKIP_PARTS.intersection(parts)
                or rel.startswith(SKIP_PREFIXES) or rel.lower().endswith(SKIP_SUFFIXES))


def fetch(dest, *, quiet=False):
    """Populate dest/genericagent and return (path, commit)."""
    repo, ref = read_pin()
    root = Path(dest) / NAME
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True)
    local = os.environ.get("GAH_GA_SOURCE")
    if local:
        files = subprocess.run(["git", "-C", local, "ls-files", "-z"], check=True,
                               capture_output=True).stdout.decode("utf-8").split("\0")
        for rel in filter(None, files):
            src = Path(local, rel)
            if keep(rel) and src.is_file():
                (root / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, root / rel)
        ref = subprocess.run(["git", "-C", local, "rev-parse", "HEAD"], check=True,
                             capture_output=True, text=True).stdout.strip()
    else:
        url = f"https://codeload.github.com/{repo}/tar.gz/{ref}"
        req = urllib.request.Request(url, headers={"User-Agent": "ga-harness-desktop-build"})
        with urllib.request.urlopen(req, timeout=300) as res:
            data = res.read()
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
            for m in tf.getmembers():
                rel = m.name.split("/", 1)[1] if "/" in m.name else ""
                if not m.isfile() or not rel or not keep(rel) or ".." in rel.split("/"):
                    continue
                out = root / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                with tf.extractfile(m) as f:
                    out.write_bytes(f.read())
                if m.mode & 0o111:
                    out.chmod(0o755)
    if not (root / "agentmain.py").is_file():
        sys.exit(f"{repo}@{ref}: agentmain.py missing from the fetched source")
    (root / REF_FILE).write_text(ref + "\n", encoding="utf-8")
    if not quiet:
        print(f"[fetch_ga] {repo}@{ref} -> {root}")
    return root, ref


def requirements(root):
    try:
        import tomllib
    except ModuleNotFoundError:   # Python < 3.11
        sys.exit("--requirements needs Python 3.11+ (tomllib)")
    data = tomllib.loads((Path(root) / "pyproject.toml").read_text(encoding="utf-8"))
    return list(data.get("project", {}).get("dependencies", []))


def main(argv):
    if not argv or argv[0].startswith("-"):
        sys.exit(__doc__)
    root, _ = fetch(argv[0])
    if "--requirements" in argv:
        i = argv.index("--requirements")
        if i + 1 >= len(argv):
            sys.exit(__doc__)
        Path(argv[i + 1]).write_text("\n".join(requirements(root)) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1:])
