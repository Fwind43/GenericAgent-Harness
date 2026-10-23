"""gah - command line entry.

  gah run "task" [--profile ga-compat] [--patch file.toml]... [--ga-root DIR]
  gah plugins                       list discovered plugin manifests
  gah tree [--profile ...]          print the resolved plugin tree
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
    args = ap.parse_args(argv)

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
