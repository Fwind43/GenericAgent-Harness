"""tool-grep: a read-only `grep` tool added to GA purely through the ga.tools service.

Args the LLM may pass: pattern (regex, required), path (dir/file, relative to the handler cwd),
glob (filename filter, e.g. "*.py"), ignore_case (bool), max_results (int).

config:
  root          base dir for relative paths (default: GA handler cwd)
  max_results   hard cap, default 200
  skip_dirs     extra dir names to skip (list, or comma-separated string)
  max_file_kb   files larger than this are skipped (default 2000)
  case          default case handling when the call omits ignore_case:
                "sensitive" (default), "insensitive", or "smart" (insensitive unless the pattern has uppercase)
"""
from __future__ import annotations
import fnmatch
import importlib
import os
import re

SKIP = {".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", "dist", "build"}
MAX_FILE = 2_000_000

SCHEMA = {
    "type": "function",
    "function": {
        "name": "grep",
        "description": "Read-only regex search over text files. Returns path:line: text matches. "
                       "Prefer this over code_run for locating code.",
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Python regex"},
                "path": {"type": "string", "description": "Dir or file to search (relative to cwd)", "default": "."},
                "glob": {"type": "string", "description": "Filename filter, e.g. *.py"},
                "ignore_case": {"type": "boolean", "description": "Omit to use the configured default"},
                "max_results": {"type": "integer", "default": 50},
            },
            "required": ["pattern"],
        },
    },
}


CASES = ("sensitive", "insensitive", "smart")


def _names(v):
    if isinstance(v, str):
        v = v.split(",")
    return {s.strip() for s in v or () if isinstance(s, str) and s.strip()}


def ignore_case_for(args, pattern, mode):
    if args.get("ignore_case") is not None:
        return bool(args.get("ignore_case"))
    if mode == "insensitive":
        return True
    return mode == "smart" and pattern == pattern.lower()


def search(base, pattern, glob=None, ignore_case=False, limit=50, skip=SKIP, max_file=MAX_FILE):
    rx = re.compile(pattern, re.I if ignore_case else 0)
    out, scanned = [], 0
    if os.path.isfile(base):
        walk = [(os.path.dirname(base), [], [os.path.basename(base)])]
    else:
        walk = os.walk(base)
    for root, dirs, files in walk:
        dirs[:] = sorted(d for d in dirs if d not in skip)
        for fn in sorted(files):
            if glob and not fnmatch.fnmatch(fn, glob):
                continue
            p = os.path.join(root, fn)
            try:
                if os.path.getsize(p) > max_file:
                    continue
                with open(p, "rb") as f:
                    data = f.read()
            except OSError:
                continue
            if b"\0" in data[:4096]:
                continue
            scanned += 1
            for no, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
                if rx.search(line):
                    out.append(f"{os.path.relpath(p, base) if p != base else fn}:{no}: {line.strip()[:240]}")
                    if len(out) >= limit:
                        return out, scanned, True
    return out, scanned, False


def make_tool(config):
    cap = int(config.get("max_results", 200))
    skip = SKIP | _names(config.get("skip_dirs"))
    root_cfg = config.get("root")
    max_file = max(1, int(config.get("max_file_kb") or MAX_FILE // 1000)) * 1000
    mode = config.get("case") if config.get("case") in CASES else "sensitive"

    def do_grep(self, args, response):
        StepOutcome = importlib.import_module("agent_loop").StepOutcome
        base_dir = root_cfg or getattr(self, "cwd", None) or os.getcwd()
        base = os.path.abspath(os.path.join(base_dir, args.get("path") or "."))
        pattern = args.get("pattern") or ""
        try:
            limit = max(1, min(int(args.get("max_results") or 50), cap))
            if not os.path.exists(base):
                raise FileNotFoundError(base)
            hits, scanned, cut = search(base, pattern, args.get("glob"), ignore_case_for(args, pattern, mode),
                                         limit, skip, max_file)
            head = f"[grep] {pattern!r} in {base}: {len(hits)} match(es), {scanned} file(s) scanned"
            if cut:
                head += f" (stopped at {limit}; narrow path/glob)"
            text = head + "\n" + "\n".join(hits)
        except (re.error, ValueError, OSError) as e:
            text = f"[Error] grep: {e}"
        anchor = getattr(self, "_get_anchor_prompt", None)
        nxt = anchor(skip=args.get("_index", 0) > 0) if anchor else "\n"
        return StepOutcome(text, next_prompt=nxt)
    return do_grep


def apply(ctx, config):
    ctx.scope.add(ctx.get("ga.tools").register(SCHEMA, make_tool(config or {})))
