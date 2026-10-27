"""project-memory: layered project memory (L0 policy / L1 index / L2 facts / L3 topics).

Activation follows GA's official ``plugins/project_mode``: the active project is
``agent._ga_project_mode_name`` (set per request by workspace-store, both in the
host and in isolated run workers).  For that project this plugin

* seeds ``<GA>/temp/projects/<name>/memory/`` with L0 ``memory_management_sop.md``,
  L1 ``project_mem_insight.txt`` and L2 ``project_mem.txt`` (create-only, never
  overwriting existing knowledge), and
* appends a ``[project memory]`` block to the system message on every LLM
  call: identity, layer rules, L1 in full, an L2 excerpt and an excerpt of the
  official ``project_memory.md`` as a read-only legacy source.

The block is delimited, so it is replaced rather than duplicated on each call and
coexists with other system-prompt plugins regardless of hook order.  GA's own
project_mode injection (L1 pointer appended to the user message) stays active.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

BEGIN = "[project memory]"
END = "[/project memory]"
_BLOCK = re.compile(r"\n*" + re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", re.S)

POLICY = (
    '# Project Memory Management\n'
    'Before any memory write, read this SOP. Use file tools and small patches; never overwrite existing knowledge.\n'
    'Only retain action-verified, durable project knowledge. No guesses, transient state, logs, transcripts, secrets or common knowledge.\n'
    'L1: project_mem_insight.txt is a minimal index, at most 30 lines, preferably below 1000 tokens.\n'
    'Use frequent scenario -> L2 section/SOP mappings, a low-frequency filename list, and RULES for one-line red lines and recurring pitfalls.\n'
    'No how-to, explanations or technical details in L1. Self-explanatory filenames need no description; parentheses only hold short scenario triggers.\n'
    'L2: project_mem.txt holds verified project facts under ## [SECTION]. L3: topic SOP .md and reusable .py files live in this memory directory. No L4.\n'
    'New L2/L3 scenarios default to low-frequency L1 pointers; remove pointers when deleting topics. Value-only updates need no L1 edit unless navigation changes.\n'
    'Keep valuable knowledge when compressing or relocating; move detail out of L1 rather than deleting it. Do not mechanically truncate old L1.\n'
    'Retired l1.md/l2.md/l3/ must not be retained or referenced as sources after knowledge is migrated to canonical files.\n'
    'Project memory supplements global memory; never change global memory or official project_memory.md as part of migration.\n'
)
INDEX = '# [Project Memory Insight]\nL0: memory_management_sop.md\nL2: project_mem.txt\nL3:\n[RULES]\n'
SEEDS = (("project_mem_insight.txt", INDEX), ("project_mem.txt", "# [Project Facts]\n"),
         ("memory_management_sop.md", POLICY))


def project_dir(hooks, name):
    """Same directory as GA's official project_mode (``<GA>/temp/projects/<name>``)."""
    try:
        from plugins import project_mode
        return Path(project_mode._project_dir(name))
    except Exception:
        return Path(hooks.__file__).resolve().parents[1] / "temp" / "projects" / name


def seed(workspace: Path) -> Path:
    workspace.mkdir(parents=True, exist_ok=True)
    try:
        with (workspace / "project_memory.md").open("x", encoding="utf-8"):
            pass
    except FileExistsError:
        pass
    memory = workspace / "memory"
    memory.mkdir(parents=True, exist_ok=True)
    for filename, heading in SEEDS:
        try:
            with (memory / filename).open("x", encoding="utf-8") as handle:
                handle.write(heading)
        except FileExistsError:
            pass
    return memory


def excerpt(path: Path, limit: int) -> str:
    try:
        with path.open("r", encoding="utf-8") as handle:
            content = handle.read(limit + 1)
    except FileNotFoundError:
        return "[Not saved: %s]" % path
    except (OSError, UnicodeError) as exc:
        return "[Unavailable: %s: %s]" % (path, exc)
    if len(content) > limit:
        content = content[:limit] + "\n[Excerpt truncated; read the source for remaining history.]"
    return "Source: %s\n%s" % (path, content)


def build(name: str, workspace: Path, memory: Path, facts_limit: int, legacy_limit: int) -> str:
    try:
        l1 = (memory / "project_mem_insight.txt").read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        l1 = "[Project L1 unavailable: %s]" % exc
    official = workspace / "project_memory.md"
    return (
        BEGIN + "\nCurrent project: " + name
        + "\nProject workspace: " + str(workspace)
        + "\nThis conversation belongs to the current project above. Use this identity, "
        "not a project inferred from global memory or previous conversation content. "
        "The workspace is project context, not evidence of a repository location or a changed process cwd. "
        "Saved facts below describe prior project work, not necessarily current deployment state. "
        "Before answering questions about earlier work, read relevant L2/L3 sources and any truncated "
        "history. Missing or partial memory does not mean no work was done. Never invent unsaved history."
        + "\nMemory directory: " + str(memory)
        + "\nL0: memory_management_sop.md; L1: project_mem_insight.txt; "
        "L2: project_mem.txt; L3: topic SOP .md/.py files in this directory. No L4. "
        "Before writing memory, read L0. L1 is a minimal two-tier scenario index plus RULES, "
        "at most 30 lines, preferably below 1000 tokens. Use only small file patches for L1, "
        "never overwrite or code execution. No how-to, technical detail, logs or secrets. "
        "Keep only action-verified durable knowledge. New/deleted L2/L3 topics require matching "
        "L1 pointers; value changes without navigation changes do not. Read L2/L3 on demand. "
        "Retired l1.md/l2.md/l3/ must not be retained as sources after migration. "
        "Project rules supplement, not replace, global rules; preserve official project storage."
        + "\nOfficial memory source (preserve the original; read and distill relevant "
        "knowledge into L1-L3 as needed): " + str(official)
        + "\n[Project L1]\n" + l1
        + "\n[Saved project facts \u2014 L2]\n" + excerpt(memory / "project_mem.txt", facts_limit)
        + "\n[Legacy project history \u2014 read-only source]\n" + excerpt(official, legacy_limit)
        + "\n" + END
    )


def apply_block(messages, text):
    """Replace (or remove, when text is None) this plugin's block in the system message."""
    index = next((i for i, m in enumerate(messages) if isinstance(m, dict) and m.get("role") == "system"), None)
    if index is None:
        if text:
            messages.insert(0, {"role": "system", "content": text})
        return
    message = messages[index]
    content = message.get("content")
    if isinstance(content, str):
        clean = _BLOCK.sub("\n", content).rstrip("\n") if BEGIN in content else content
        new = clean + ("\n\n" + text if text else "")
    elif isinstance(content, list):
        new = [b for b in content if not (isinstance(b, dict) and BEGIN in str(b.get("text", "")))]
        if text:
            new.append({"type": "text", "text": text})
    else:
        return
    if new != content:
        messages[index] = {**message, "content": new}


OFFICIAL_MODULE = "plugins.project_mode"


def suppress_official(hooks):
    """Detach GA's official project_mode injection so the model receives one memory policy.

    The official plugin appends its own project context (single project_memory.md, write-back
    reminder) to the user message on ``agent_before``; that contradicts the layered L1-L3 rules.
    GA source is untouched: only its callbacks are removed from GA's hook registry.
    Returns the removed callbacks so they can be restored when this plugin unloads.
    """
    registry = getattr(hooks, "_registry", None)
    if not isinstance(registry, dict):
        return []
    removed = []
    for event, callbacks in list(registry.items()):
        for fn in list(callbacks or ()):
            if getattr(fn, "__module__", None) == OFFICIAL_MODULE:
                hooks.unregister(event, fn)
                removed.append((event, fn))
    return removed


def apply(ctx, config):
    hooks = ctx.get("ga.hooks")
    removed = []

    def detach():
        removed.extend(suppress_official(hooks))

    def restore():
        for event, fn in removed:
            if fn not in hooks._registry.get(event, []):
                hooks.register(event)(fn)
        removed.clear()

    detach()
    ctx.scope.add(restore)
    facts_limit = int(config.get("facts_limit") or 10000)
    legacy_limit = int(config.get("legacy_limit") or 6000)

    def before(g, nxt):
        messages = g.get("messages")
        handler = g.get("handler")
        agent = getattr(handler, "parent", None)
        if isinstance(messages, list) and agent is not None:
            name = getattr(agent, "_ga_project_mode_name", None)
            text = None
            if name:
                try:
                    workspace = project_dir(hooks, name)
                    text = build(name, workspace, seed(workspace), facts_limit, legacy_limit)
                except OSError as exc:
                    text = BEGIN + "\n[Project memory unavailable for %s: %s]\n" % (name, exc) + END
            apply_block(messages, text)
        return nxt(g)

    def agent_before(g, nxt):
        detach()  # official plugin may load after this one; effective from the next hook dispatch
        return nxt(g)

    ctx.on("ga.agent_before", agent_before)
    ctx.on("ga.llm_before", before)
    ctx.provide("project.memory", {"project_dir": lambda name: project_dir(hooks, name)})
