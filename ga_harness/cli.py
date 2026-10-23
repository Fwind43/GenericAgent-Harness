"""gah - command line entry.

  gah run "task" [--profile ga-compat] [--patch file.toml]... [--ga-root DIR]
  gah plugins                       list discovered plugin manifests
  gah tree [--profile ...]          print the resolved plugin tree
  gah llm show [--file F]           show the LLM config GA would see (secrets masked)
  gah llm migrate MYKEY_PY [--out F] [--force]
                                    convert a GA mykey.py into a harness llm.toml
"""
from __future__ import annotations
import argparse
import os
import sys
from pathlib import Path

from .kernel import Runtime
from .kernel.loader import build_tree, discover, mount

PKG = Path(__file__).resolve().parent
PLUGIN_DIRS = [PKG / "plugins"]
PROFILE_DIRS = [PKG / "profiles"]


def _extra_dirs(env: str) -> list[Path]:
    return [Path(p) for p in os.environ.get(env, "").split(os.pathsep) if p]


def _tree(args):
    tree = build_tree(args.profile, PROFILE_DIRS + _extra_dirs("GAH_PROFILE_PATH"), args.patch)
    if args.ga_root:
        for e in tree:
            if e["name"].startswith("ga-"):
                e["config"].setdefault("ga_root", args.ga_root)
    return tree


def _llm(args) -> int:
    import json
    from . import llmconfig
    if args.llm_cmd == "show":
        src = llmconfig.Source(args.file or llmconfig.default_path())
        if not src.available:
            print(f"[gah] {src.file} not found -> GA would fall back to its own mykey.py", file=sys.stderr)
            return 1
        data = src.load()
        print(f"# {src.origin}")
        print("# LLM entries:", [k for k in data if llmconfig.is_llm_key(k)])
        print(json.dumps(llmconfig.mask(data), ensure_ascii=False, indent=2))
        return 0
    out = Path(args.out) if args.out else llmconfig.default_path()
    if out.exists() and not args.force:
        print(f"[gah] {out} exists; use --force to overwrite", file=sys.stderr)
        return 1
    data = llmconfig.read_mykey_py(args.mykey)
    skipped = data.pop("_skipped", [])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(llmconfig.to_toml(data), encoding="utf-8")
    print(f"[gah] wrote {out}: {[k for k in data if llmconfig.is_llm_key(k)]}")
    if skipped:
        print(f"[gah] skipped non-config names: {skipped}")
    print("[gah] tip: replace literal keys with \"${ENV_NAME}\" if you prefer env vars")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="gah")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("run", "tree"):
        p = sub.add_parser(name)
        p.add_argument("--profile", default="ga-compat")
        p.add_argument("--patch", action="append", default=[])
        p.add_argument("--ga-root", default=os.environ.get("GA_ROOT"))
        if name == "run":
            p.add_argument("task")
            p.add_argument("--timeout", type=float, default=None)
    sub.add_parser("plugins")
    lp = sub.add_parser("llm").add_subparsers(dest="llm_cmd", required=True)
    s = lp.add_parser("show")
    s.add_argument("--file", default=None)
    m = lp.add_parser("migrate")
    m.add_argument("mykey")
    m.add_argument("--out", default=None)
    m.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)
    if args.cmd == "llm":
        return _llm(args)

    manifests = discover(PLUGIN_DIRS + _extra_dirs("GAH_PLUGIN_PATH"))
    if args.cmd == "plugins":
        for m in manifests.values():
            print(f"{m.name:16} {getattr(m, 'description', '')}")
        return 0
    tree = _tree(args)
    if args.cmd == "tree":
        for e in tree:
            print(("- " if e["disabled"] else "+ ") + e["name"], e["config"] or "")
        return 0

    rt = Runtime()
    try:
        mount(rt, tree, manifests)
        bad = {k: v for k, v in rt.status().items() if v.get("state") != "active"}
        if bad:
            print(f"[gah] plugins not active: {bad}", file=sys.stderr)
        agent = rt.ctx.get("agent")
        if agent is None:
            print("[gah] no plugin provides `agent`", file=sys.stderr)
            return 2
        rt.ctx.events.on("agent.chunk", lambda t: (sys.stdout.write(t), sys.stdout.flush()))
        agent.run(args.task, timeout=args.timeout)
        print()
        return 0
    finally:
        rt.dispose()


if __name__ == "__main__":
    sys.exit(main())
