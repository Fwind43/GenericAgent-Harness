"""gah - command line entry.

  gah run ["task"] [--ui cli|tui|web] [--profile ga-compat] [--patch file.toml]... [--ga-root DIR]
                                    (the frontend is a plugin: ui-<name>, default ui-cli)
                                    (re-runs itself under DIR/.venv python when needed)
  gah plugins                       list discovered plugin manifests
  gah tree [--profile ...]          print the resolved plugin tree
"""
from __future__ import annotations
import argparse
import os
import sys
from pathlib import Path

from . import paths
from .kernel import Runtime
from .kernel.loader import build_tree, discover, mount

PKG = Path(__file__).resolve().parent
PLUGIN_DIRS = [PKG / "plugins", paths.home() / "plugins"]  # user plugins override built-ins
PROFILE_DIRS = [PKG / "profiles"]


def _extra_dirs(env: str) -> list[Path]:
    return [Path(p) for p in os.environ.get(env, "").split(os.pathsep) if p]


def _err(msg: str) -> None:
    """Report to the real stderr. Once ga-stdout is mounted, sys.stderr is a proxy that turns
    lines into agent.log events, so failures printed there would never reach the terminal or
    a supervising process (the desktop shell's backend.log)."""
    stream = sys.__stderr__ or sys.stderr
    try:
        print(msg, file=stream, flush=True)
    except Exception:
        pass


def select_frontend(tree: list[dict], manifests: dict, ui: str | None) -> list[dict]:
    """Ensure exactly one frontend plugin. --ui NAME replaces any frontend in the tree with
    ui-NAME; otherwise the tree's own frontend wins, falling back to ui-cli."""
    def is_fe(e):
        m = manifests.get(e["name"])
        return m is not None and "frontend" in m.provides
    if ui is None and any(is_fe(e) and not e["disabled"] for e in tree):
        return tree
    name = f"ui-{ui or 'cli'}"
    if name not in manifests:
        raise SystemExit(f"[gah] unknown frontend {name!r}; have: "
                         + ", ".join(sorted(n for n, m in manifests.items() if "frontend" in m.provides)))
    tree = [e for e in tree if not is_fe(e)]
    tree.append({"name": name, "config": {}, "disabled": False})
    return tree


def _tree(args, manifests=None):
    tree = build_tree(args.profile, PROFILE_DIRS + _extra_dirs("GAH_PROFILE_PATH"), args.patch)
    if manifests is not None:
        tree = select_frontend(tree, manifests, getattr(args, "ui", None))
        enabled = {e["name"] for e in tree if not e["disabled"]}
        if {"ui-web", "session-store", "workspace-store"} <= enabled and "run-store" in manifests:
            if not any(e["name"] == "run-store" for e in tree):
                index = next(i for i, e in enumerate(tree) if e["name"] == "ui-web")
                tree.insert(index, {"name": "run-store", "config": {}, "disabled": False})
    if args.ga_root:
        for e in tree:
            if e["name"].startswith("ga-") or e["name"] == "session-store":
                e["config"].setdefault("ga_root", args.ga_root)
    return tree


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="gah")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("run", "tree"):
        p = sub.add_parser(name)
        p.add_argument("--profile", default="ga-compat")
        p.add_argument("--patch", action="append", default=[])
        p.add_argument("--ga-root", default=None,
                       help="GenericAgent checkout (default: $GA_ROOT, then $GAH_HOME/config.toml ga_root)")
        p.add_argument("--ui", default=None, help="frontend plugin ui-<UI> (cli, tui, web, ...)")
        if name == "run":
            p.add_argument("task", nargs="?", default=None)
            p.add_argument("--timeout", type=float, default=None)
            scope = p.add_mutually_exclusive_group()
            scope.add_argument("--workspace", help="start a new conversation in this absolute server directory")
            scope.add_argument("--project", help="select an existing project by ID")
    sub.add_parser("plugins")
    raw = list(sys.argv[1:] if argv is None else argv)
    args = ap.parse_args(raw)
    if args.cmd in ("run", "tree"):
        from . import launcher
        args.ga_root = launcher.resolve_ga_root(args.ga_root)
        if args.cmd == "run":
            rc = launcher.maybe_reexec(raw, args.ga_root)
            if rc is not None:
                return rc

    manifests = discover(PLUGIN_DIRS + _extra_dirs("GAH_PLUGIN_PATH"))
    if args.cmd == "plugins":
        for m in manifests.values():
            print(f"{m.name:16} {getattr(m, 'description', '')}")
        return 0
    tree = _tree(args, manifests)
    from .plugin_manager import PluginPreferences, settings_path
    preferences = PluginPreferences(settings_path(), args.profile, manifests, tree)
    try:
        tree = preferences.resolve(preferences.read()[0])
    except (ValueError, OSError):
        _err("[gah] plugin settings could not be loaded; repair $GAH_PLUGIN_CONFIG before launching")
        return 2
    if args.cmd == "tree":
        for e in tree:
            print(("- " if e["disabled"] else "+ ") + e["name"], e["config"] or "")
        return 0

    if args.workspace or args.project:
        entry = next((e for e in tree if e["name"] == "workspace-store" and not e["disabled"]), None)
        if entry is None:
            _err("[gah] workspace selection requires workspace-store")
            return 2
        entry["config"] = {**(entry["config"] or {}),
                           "start_workspace": args.workspace, "start_project": args.project}

    rt = Runtime()
    try:
        rt.ctx.provide("plugin.catalog", {"preferences": preferences, "tree": tree})
        mount(rt, tree, manifests)
        from .plugin_manager import frontend_capabilities
        dormant = frontend_capabilities(manifests)
        bad = {k: v for k, v in rt.status().items() if v.get("state") != "active"
               and not (v.get("missing") and set(v["missing"]) <= dormant)}
        if bad:
            _err(f"[gah] plugins not active: {bad}")
        if (args.workspace or args.project) and rt.ctx.get("workspaces") is None:
            _err("[gah] requested workspace/project could not be activated; refusing to run")
            return 2
        frontend = rt.ctx.get("frontend")
        if frontend is None:
            _err("[gah] no active plugin provides `frontend` (does it have its `agent`?)")
            return 2
        return frontend.main(task=args.task, timeout=args.timeout)
    finally:
        rt.dispose()


if __name__ == "__main__":
    sys.exit(main())
