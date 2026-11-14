"""Conductor mode: a session that plans and delegates instead of doing the work.

Modelled on GA Admin's Conductor. A session with conductor mode on becomes the
*parent*: its agent may only use the ``conductor_*`` tools (plus ``ask_user``,
``update_working_checkpoint`` and ``no_tool``). Each ``conductor_dispatch``
creates a child session that runs the objective as an ordinary task. The parent
collects results, inspects them, sends further instructions, reviews every
finished task (``verified`` / ``needs_work`` with a mandatory basis) and resolves
it. When a child finishes while the parent is idle, the parent is woken with a
short summary so it can continue.

Limits per parent session: 5 running, 12 unresolved, 48 in total. The conductor
may change its own running limit (1..RUNNING_CAP) with ``conductor_set_limit``;
the value is kept per parent session in ``conductor.json``.

The worker side (tool registration and tool fencing) lives in the worker-only
``conductor-worker`` plugin; it talks to this plugin through the ``conductor``
RPC service. Instructions to running children reuse ``ga-steer``.

State is written through to ``conductor.json`` beside the session database.
"""
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

from ga_harness import model_keys
from ga_harness.sessions import EFFORTS
from .reflections import Reflections, SOURCE as REFLECT_SOURCE

POLICY_MAX = 4000  # characters of model-selection policy text

HERE = Path(__file__).resolve().parent
log = logging.getLogger(__name__)

MAX_RUNNING = 5
MAX_OPEN = 12
MAX_TOTAL = 48  # new tasks per stage, not a lifetime session cap
STAGE_HISTORY = 12  # bounded handoffs; old task/session records remain inspectable
RUNNING_CAP = 8  # highest running limit a conductor may set for itself
MAX_TEXT = 20_000
RESULT_LIMIT = 4_000
BRIEF_LIMIT = 200  # per text field in the page snapshot; the panel loads the rest on demand
WAKE_RESULT_LIMIT = 1_500  # per task in the wake-up message; full text via collect/inspect
TERMINAL = ("done", "error", "aborted", "interrupted")
VERDICTS = ("verified", "needs_work")
SOURCE = "conductor"
WAKE_COALESCE = 0.3  # seconds to gather children finishing together into one wake-up
WAKE_RETRIES = 5  # further attempts when a wake-up message could not be submitted
WAKE_RETRY_DELAY = 5.0  # seconds between those attempts
CONTINUE_DELAY = 1.0  # seconds after the conductor's turn ends before prompting it again
ACTIVE_IDLE_LIMIT = 3  # consecutive prompted turns without progress before 30m idle backoff
ACTIVE_IDLE_INTERVAL = 1800.0  # seconds between continuation prompts once in idle backoff


def _reflect_requested(messages):
    """A prompt-size hint, not permission to start an event source."""
    for message in reversed(messages):
        if message.get("role") != "user" or message.get("source", "user") != "user":
            continue
        text = message.get("text") or ""
        return bool(re.search(
            r"\b(?:monitor(?:ing)?|watch(?:ing)?|poll(?:ing)?|periodic(?:ally)?|"
            r"schedule[d]?|notify|notification[s]?|reflect)\b|"
            r"监控|监听|盯盘|轮询|定时|定期|通知我|提醒我",
            text, re.IGNORECASE))
    return False


def _store_path(sessions):
    base = getattr(sessions, "path", None)
    return Path(base).with_name("conductor.json") if base else HERE / "conductor.json"


def _directory(value):
    """An existing absolute directory, resolved (same rule as the workspaces plugin)."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("workspace must be an existing absolute directory")
    path = Path(value.strip()).expanduser()
    if not path.is_absolute() or not path.is_dir():
        raise ValueError("workspace must be an existing absolute directory on the server")
    return str(path.resolve())


def _git(cwd, *args, timeout=60):
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    done = subprocess.run(["git", *args], cwd=cwd, capture_output=True, timeout=timeout,
                          creationflags=flags, stdin=subprocess.DEVNULL)
    out = done.stdout.decode("utf-8", "replace").strip()
    if done.returncode:
        err = done.stderr.decode("utf-8", "replace").strip() or out
        raise RuntimeError(f"git {args[0]} failed: {err[:500]}")
    return out


def _add_worktree(source, root, task_id):
    """Check out a fresh branch of the repository at `source` into its own directory.

    Returns (working directory, branch, repository top, base commit, worktree root). The worktree
    starts from the source's HEAD; uncommitted changes in the source are not copied.
    """
    try:
        top = _git(source, "rev-parse", "--show-toplevel")
    except (OSError, RuntimeError) as error:
        raise ValueError(f"isolate needs a git repository: {source} ({error})") from None
    top = str(Path(top).resolve())
    base = _git(top, "rev-parse", "HEAD")
    branch = f"conductor/{task_id}"
    target = Path(root) / task_id
    target.parent.mkdir(parents=True, exist_ok=True)
    _git(top, "worktree", "add", "-b", branch, str(target), base, timeout=300)
    # Keep the task in the same subdirectory of the repository it was asked to work in.
    rel = Path(source).resolve().relative_to(top) if Path(source).resolve() != Path(top) else Path()
    workdir = target / rel
    return str(workdir if workdir.is_dir() else target), branch, top, base, str(target)


def _remove_worktree(task):
    """Remove a task's worktree directory; the branch (and its commits) is kept."""
    path = task.get("worktree")
    if not path:
        return
    _git(task.get("repo") or path, "worktree", "remove", "--force", path, timeout=120)
    task["worktree_removed"] = True


def _worktree_changes(task):
    """One-line `git status` / commit count of a task's worktree (best effort)."""
    path = task.get("worktree")
    if not path or task.get("worktree_removed") or not Path(path).is_dir():
        return ""
    try:
        commits = _git(path, "rev-list", "--count", f"{task['base']}..HEAD", timeout=20)
        dirty = _git(path, "status", "--porcelain", timeout=20).splitlines()
    except (OSError, RuntimeError, subprocess.TimeoutExpired):
        return ""
    return f"{commits} new commit(s), {len(dirty)} uncommitted change(s)"


def _message_result(message):
    """Return a delivery, never the raw execution transcript or an earlier plan.

    Only the last structured assistant turn can be the final answer. A run ending
    on a tool, an empty turn or a partial reply has no complete delivery.
    """
    missing = {"result": "", "result_complete": False, "result_source": "missing_final"}
    if not isinstance(message, dict):
        return missing
    turns = message.get("turns")
    if not isinstance(turns, list) or not turns or not isinstance(turns[-1], dict):
        return missing
    turn = turns[-1]
    reply = turn.get("reply")
    if not isinstance(reply, str) or not reply.strip():
        return missing
    tools = turn.get("tools") or []
    if any(not isinstance(t, dict) or t.get("name") != "no_tool" for t in tools):
        return missing
    complete = (turn.get("status") == "done"
                and message.get("status", "done") == "done")
    return {"result": reply.strip(), "result_complete": complete,
            "result_source": "final_turn" if complete else "partial_turn"}


def _failure(record, message=None):
    """Prefer explicit worker classifications; never guess that every error is a model error."""
    status = record.get("status")
    if status == "aborted":
        return {"failure_kind": "user_aborted", "retryable": False}
    if status == "interrupted":
        return {"failure_kind": "host_restart", "retryable": True}
    if status != "error":
        return {"failure_kind": None, "retryable": False}
    kind = record.get("failure_kind")
    if kind:
        return {"failure_kind": kind, "retryable": bool(record.get("retryable"))}
    text = str(record.get("error") or "").lower()
    if any(word in text for word in ("rate limit", "429", "503", "502", "model unavailable", "model call failed",
                                     "connection error", "connectionerror", "timed out", "timeout")):
        return {"failure_kind": "model_unavailable", "retryable": True}
    turns = (message or {}).get("turns") or []
    if any(tool.get("ok") is False or tool.get("status") == "error"
           for turn in turns[-1:] for tool in (turn.get("tools") or []) if isinstance(tool, dict)):
        return {"failure_kind": "tool_error", "retryable": False}
    return {"failure_kind": "execution_error", "retryable": False}


def _task_metrics(record, message):
    message = message or {}
    turns = message.get("turns") or []
    usage = message.get("usage")
    keys = ("calls", "input", "output", "cache_read", "cache_write")
    if not isinstance(usage, dict):
        usage = {k: sum((t.get("usage") or {}).get(k, 0) or 0 for t in turns) for k in keys}
    created, ended = record.get("created"), record.get("ended")
    seconds = max(0, ended - created) if isinstance(created, (int, float)) and isinstance(ended, (int, float)) else None
    return {"seconds": seconds, "turns": len(turns),
            "usage": {k: usage[k] for k in keys if isinstance(usage.get(k), (int, float))}}


def _message_text(message):
    return _message_result(message)["result"]


AUTOPILOT_META_TOOLS = frozenset({
    "no_tool", "conductor_checkpoint", "conductor_finish",
    "autopilot_checkpoint", "autopilot_finish", "ask_user",
})


def _message_tool_flags(message):
    """Return (asked_user, tool_progress) from structured turn tool records."""
    turns = message.get("turns") or [] if isinstance(message, dict) else []
    asked_user = False
    tool_progress = False
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        for tool in turn.get("tools") or []:
            if not isinstance(tool, dict):
                continue
            name = tool.get("name") or ""
            if tool.get("ok") is False or tool.get("status") == "error":
                continue
            if name == "ask_user":
                asked_user = True
            elif name and name not in AUTOPILOT_META_TOOLS:
                tool_progress = True
    return asked_user, tool_progress


def _clip(text, limit=RESULT_LIMIT):
    text = text or ""
    if len(text) <= limit:
        return text
    # Preserve the end too: it commonly holds evidence, caveats and blockers.
    head = limit * 2 // 3
    return (text[:head] + f"\n...[{len(text) - limit} chars omitted; use conductor_inspect]...\n"
            + text[-(limit - head):])


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.persistence_error = None
        self.archive_error = None
        self.data = {"enabled": {}, "tasks": {}, "limits": {}, "policies": {}, "defaults": {},
                     "active": {}, "reflections": {}, "progress": {}, "deliveries": {}, "auto": {}}
        try:
            if self.path.is_file():
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    for key in ("deliveries", "auto"):
                        self.data[key] = {k: v for k, v in dict(loaded.get(key) or {}).items()
                                          if isinstance(v, dict)}
                    self.data["enabled"] = dict(loaded.get("enabled") or {})
                    self.data["active"] = {k: True for k, v in dict(loaded.get("active") or {}).items() if v}
                    self.data["tasks"] = dict(loaded.get("tasks") or {})
                    self.data["progress"] = {k: v for k, v in dict(loaded.get("progress") or {}).items()
                                             if isinstance(v, dict)}
                    for task in self.data["tasks"].values():
                        if "result_source" not in task:
                            # Legacy result was the tool transcript, not a final delivery.
                            task.update(result="", result_complete=False, result_source="legacy_unavailable")
                    self.data["reflections"] = {k: v for k, v in dict(loaded.get("reflections") or {}).items()
                                                if isinstance(v, dict)}
                    self.data["limits"] = dict(loaded.get("limits") or {})
                    self.data["defaults"] = {k: v for k, v in dict(loaded.get("defaults") or {}).items()
                                          if isinstance(v, dict) and v}
                    self.data["policies"] = {k: v for k, v in dict(loaded.get("policies") or {}).items()
                                          if isinstance(v, str) and v.strip()}
        except Exception as error:
            log.warning("conductor: could not load %s: %s", self.path, error)
        # A task that was running when the server stopped cannot be followed any more.
        for task in self.data["tasks"].values():
            if task.get("status") == "running":
                task["status"] = "interrupted"
                task["finished"] = task.get("finished") or time.time()
                task.update(failure_kind="host_restart", retryable=True, acked=False, notified=False)

    def _archive_path(self, task):
        name = uuid.uuid5(uuid.NAMESPACE_URL, str(task["id"])).hex + ".json"
        return self.path.with_name(self.path.stem + "-archive") / name

    def full_task(self, task):
        if not task.get("archived"):
            return task
        # Do not silently present a preview as the full delivery if the archive is lost.
        fields = json.loads(self._archive_path(task).read_text(encoding="utf-8"))
        return {**task, **fields}

    def archive(self):
        """Move heavy fields of resolved, previous-stage tasks out of the hot store.

        Keep routing/review/worktree metadata and previews so old tasks can still be
        inspected or reused. Write the immutable archive before replacing any fields.
        A crash before the main save only leaves a harmless duplicate archive.
        """
        self.archive_error = None
        for task in self.data["tasks"].values():
            stage = self.data["progress"].get(task.get("parent"), {}).get("stage", 1)
            if (task.get("archived") or not task.get("resolved")
                    or task.get("stage", 1) >= stage):
                continue
            tmp = None
            try:
                path = self._archive_path(task)
                fields = {k: task.get(k) or "" for k in ("objective", "result", "error", "basis")}
                path.parent.mkdir(parents=True, exist_ok=True)
                fd, tmp = tempfile.mkstemp(prefix=".archive-", dir=str(path.parent))
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump(fields, fh, ensure_ascii=False)
                    fh.flush()
                    os.fsync(fh.fileno())
                Path(tmp).replace(path)
                task.update({k: v[:BRIEF_LIMIT] for k, v in fields.items()})
                task["archived"] = True
            except Exception as error:
                self.archive_error = str(error)
                log.warning("conductor: could not archive task: %s", error)
                break  # keep the original full fields and retry on the next save
            finally:
                if tmp is not None:
                    Path(tmp).unlink(missing_ok=True)

    def save(self):
        self.archive()
        tmp = None
        try:
            text = json.dumps(self.data, ensure_ascii=False, indent=1)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".conductor-", dir=str(self.path.parent))
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(text)
                fh.flush()
                os.fsync(fh.fileno())
            Path(tmp).replace(self.path)
            self.persistence_error = None
            return True
        except Exception as error:
            self.persistence_error = str(error)
            log.warning("conductor: could not save state: %s", error)
            return False
        finally:
            if tmp is not None:
                Path(tmp).unlink(missing_ok=True)


def apply(ctx, config):
    host, runs, sessions = ctx.get("web.host"), ctx.get("runs"), ctx.get("sessions")
    frontend = host.frontend
    lock = threading.RLock()
    changed = threading.Condition(lock)
    scheduled, continued, waking = {}, {}, set()  # cancellable timers / in-flight parents
    store = Store(_store_path(sessions))
    tasks, enabled, overrides = store.data["tasks"], store.data["enabled"], store.data["limits"]
    policies = store.data["policies"]  # parent -> model-selection policy text (system prompt)
    active = store.data["active"]  # parents in active mode: keep going until conductor_finish
    # Durable active-mode progress per parent: {"finished": bool, "idle": int, "ops": int}.
    # "idle" counts consecutive continuation turns in which the conductor used no conductor
    # operation; "ops" counts operations since the last parent run ended.
    auto = store.data["auto"]
    progress = store.data["progress"]  # durable goal, stage handoff and wait state
    deliveries = store.data["deliveries"]
    defaults = store.data["defaults"]  # parent -> {"model": name, "model_key": key, "effort": level}; absent = inherit

    # ---- helpers ---------------------------------------------------------
    def _sid(body, key="session_id"):
        sid = body.get(key)
        if not isinstance(sid, str) or not sid:
            raise ValueError(f"{key} is required")
        return sid

    def _text(body, key, required=True, limit=MAX_TEXT):
        value = body.get(key)
        if value is None and not required:
            return ""
        if not isinstance(value, str) or (required and not value.strip()):
            raise ValueError(f"{key} is required")
        if len(value) > limit:
            raise ValueError(f"{key} is too long")
        return value.strip()

    def _owned(parent, task_id):
        task = tasks.get(task_id) if isinstance(task_id, str) else None
        if task is None or task["parent"] != parent:
            raise ValueError("task not found")
        return task

    def _children(parent):
        return sorted((t for t in tasks.values() if t["parent"] == parent), key=lambda t: t["created"])

    def _task_of_child(sid):
        # A reused child session holds several tasks over time; the newest is current.
        found = None
        for task in tasks.values():
            if task["child"] == sid and (found is None or task["created"] >= found["created"]):
                found = task
        return found

    def _public(task, full=False, brief=False):
        if full:
            task = store.full_task(task)
        out = {k: task.get(k) for k in ("id", "title", "status", "review", "basis", "resolved",
                                        "child", "run_id", "created", "finished", "runs",
                                        "model", "model_key", "effort", "workspace", "reused_from", "stage",
                                        "result_complete", "result_source", "failure_kind", "retryable",
                                        "metrics", "total_metrics")}
        out["result_truncated"] = bool(not full and (task.get("archived") or len(task.get("result") or "") > RESULT_LIMIT))
        if task.get("archived") and not full:
            out["partial"] = True
        if task.get("branch"):
            out["branch"] = task["branch"]
            out["worktree"] = None if task.get("worktree_removed") else task.get("worktree")
            changes = _worktree_changes(task) if full and task.get("status") in TERMINAL else ""
            if changes:
                out["changes"] = changes
        out["objective"] = task["objective"] if full else _clip(task["objective"], 300)
        if task.get("status") in TERMINAL:
            out["result"] = task.get("result", "") if full else _clip(task.get("result", ""))
            if task.get("error"):
                out["error"] = task["error"]
        if brief:
            # The snapshot is rebroadcast on every state change: send previews only and
            # flag the task so the panel fetches the full text when a row is opened.
            for key, limit in (("objective", 300), ("result", BRIEF_LIMIT),
                               ("error", BRIEF_LIMIT), ("basis", BRIEF_LIMIT)):
                text = task.get(key) or ""
                if key in out and len(text) > limit:
                    out[key] = text[:limit] + "\u2026"
                    out["partial"] = True
        return out

    def _max_running(parent):
        value = (overrides.get(parent) or {}).get("running") if isinstance(parent, str) else None
        return value if isinstance(value, int) and 1 <= value <= RUNNING_CAP else MAX_RUNNING

    def _limits(parent):
        return {"running": _max_running(parent), "open": MAX_OPEN, "total": MAX_TOTAL,
                "running_cap": RUNNING_CAP}

    def _progress(parent):
        return progress.setdefault(parent, {"stage": 1, "goal": "", "next_step": "",
                                            "status": "active", "reason": "", "history": []})

    def _cancel_continue(parent):
        entry = continued.pop(parent, None)
        if entry:
            entry[1].cancel()

    def _counts(parent):
        items = _children(parent)
        state = _progress(parent)
        return {"running": sum(t["status"] == "running" for t in items),
                "open": sum(not t["resolved"] for t in items),
                "total": len(items),  # historical count for compatibility
                "stage_total": sum(t.get("stage", 1) == state["stage"] for t in items),
                "progress": {**state, "history": list(state.get("history", []))},
                "limits": _limits(parent),
                "awaiting_review": [t["id"] for t in items
                                    if t["status"] in TERMINAL and not t["resolved"]
                                    and t.get("review") == "pending"]}

    # ---- model scheduling ----------------------------------------------
    def _catalog():
        try:
            service = ctx.get("models")
        except Exception:
            service = None
        if service is None:
            return None
        try:
            return [row for row in (service.catalog().get("items") or []) if row.get("name")]
        except Exception as error:
            log.warning("conductor: model catalog unavailable: %s", error)
            return None

    def _model_name(value):
        """Resolve a requested model to {"model": name, "model_key": key}: its unique
        configuration key first, then an unambiguous exact name, case-insensitive
        name or model id. A name shared by several models must be given by key."""
        if not isinstance(value, str) or not value.strip():
            raise ValueError("model must be a configured model key or name")
        value = value.strip()
        rows = _catalog()
        if rows is None:
            raise RuntimeError("model selection is unavailable (no model catalog)")
        pick = lambda row: {"model": row["name"], "model_key": row.get("key")}
        hit = [row for row in rows if row.get("key") and row["key"] == value]
        if len(hit) == 1:
            return pick(hit[0])
        for test in ((lambda row: row["name"] == value),
                     (lambda row: row["name"].lower() == value.lower()),
                     (lambda row: str(row.get("model") or "").lower() == value.lower())):
            hit = [row for row in rows if test(row)]
            if len(hit) == 1:
                return pick(hit[0])
            if len(hit) > 1:
                keys = ", ".join(str(row.get("key") or row["name"]) for row in hit)
                raise ValueError(f"model {value!r} matches several models; give one key: {keys}")
        raise ValueError(f"unknown model {value!r}; call conductor_models for the configured keys")

    def _stored(state):
        """The model selection stored in a session state / default, or None."""
        name = state.get("model")
        if not isinstance(name, str) or not name:
            return None
        key = state.get("model_key")
        return {"model": name, "model_key": key if isinstance(key, str) and key else None}

    def _effort(value):
        if not isinstance(value, str) or value.strip().lower() not in EFFORTS:
            raise ValueError(f"effort must be one of {', '.join(EFFORTS)}")
        return value.strip().lower()

    def _parent_selection(parent):
        """The conductor session's own model/effort (what tasks inherit)."""
        state = {}
        try:
            state = dict((sessions.get(parent, light=False) or {}).get("state") or {})
        except Exception:
            pass
        model = _stored(state)
        if model is None:
            try:
                model = _stored(model_keys.selection(getattr(sessions, "agent", None)))
            except Exception:
                model = None
        effort = state.get("effort") if "effort" in state else getattr(getattr(sessions, "agent", None),
                                                                        "gah_reasoning_effort", None)
        return model, effort if effort in EFFORTS else None

    def _requested(body):
        """Validated per-call model/effort overrides (None = not given)."""
        model = body.get("model")
        effort = body.get("effort")
        model = None if model in (None, "") else _model_name(model)
        effort = None if effort in (None, "") else _effort(effort)
        return model, effort

    def _selection(parent, model=None, effort=None):
        """Per-call choice > this conductor's default > the conductor's own selection.
        The policy is prose for the conductor's prompt; it never picks a model itself."""
        with lock:
            default = dict(defaults.get(parent) or {})
        own_model, own_effort = _parent_selection(parent)
        return (model or _stored(default) or own_model,
                effort or default.get("effort") or own_effort)

    def _apply_selection(task, model, effort):
        values = {}
        if model:
            values.update(model)  # name + key (None clears a stale key)
        if effort:
            values["effort"] = effort
        if values:
            sessions.remember_for(task["child"], **values)
            task.update(values)

    def _publish():
        with lock:
            store.save()
            changed.notify_all()
        try:
            frontend.broadcast("snapshot", frontend.snapshot())
        except Exception:
            pass

    def _start(task, text):
        record = runs.start(text, session_id=task["child"], source=SOURCE)
        task.update(status="running", run_id=record["id"], finished=None, review="pending",
                    basis="", resolved=False, acked=False, notified=False, error="",
                    result="", result_complete=False, result_source="missing_final",
                    failure_kind=None, retryable=False, metrics=None)
        task["runs"] = task.get("runs", 0) + 1

    # ---- operations (shared by the RPC service and the web routes) -------
    def role(body):
        sid = _sid(body)
        with lock:
            if enabled.get(sid):
                return {"role": "parent", **_counts(sid), "policy": policies.get(sid),
                        "active": bool(active.get(sid)),
                        "reflect_requested": _reflect_requested((sessions.get(sid) or {}).get("messages") or []),
                        "reflect_active": any(r.get("status") in ("running", "pending", "submitting", "waiting", "callback")
                                              for r in reflections.listing(sid))}
            task = _task_of_child(sid)
            if task is not None:
                return {"role": "worker", "task_id": task["id"], "parent": task["parent"]}
            if active.get(sid):
                return {"role": "none", "active": True, "progress": _counts(sid)["progress"]}
        return {"role": "none"}

    def dispatch(body):
        parent = _sid(body)
        objective = _text(body, "objective")
        title = _text(body, "title", required=False, limit=100) or objective.splitlines()[0][:60]
        model, effort = _requested(body)
        workspace, isolate = body.get("workspace"), body.get("isolate", False)
        if not isinstance(isolate, bool):
            raise ValueError("isolate must be true or false")
        if workspace is not None:
            workspace = _directory(workspace)
        reuse = body.get("reuse_task")
        # Tool callers may represent an omitted optional string as "".
        if reuse == "":
            reuse = None
        if reuse is not None and (isolate or workspace is not None):
            raise ValueError("reuse_task cannot be combined with workspace or isolate; "
                             "the task keeps the reused session's workspace")
        task_id = "t" + uuid.uuid4().hex[:8]
        reused = None
        worktree = None
        if isolate:
            source = workspace or sessions.get(parent, light=True).get("workspace") or ""
            if not source:
                raise ValueError("isolate needs a workspace; pass one explicitly")
            with lock:  # cheap pre-check so a refused dispatch does not create a worktree
                if _counts(parent)["open"] >= MAX_OPEN:
                    raise RuntimeError(f"{MAX_OPEN} tasks are unresolved; review and resolve some first")
            worktree = _add_worktree(_directory(source), _store_path(sessions).with_name("conductor-worktrees"),
                                     task_id)
            workspace = worktree[0]
        failed = None
        try:
            with lock:
                counts = _counts(parent)
                if counts["stage_total"] >= MAX_TOTAL:
                    raise RuntimeError(f"stage task limit reached ({MAX_TOTAL}); review and resolve all "
                                       "tasks, then use conductor_checkpoint(action='advance') with a "
                                       "handoff and next step; never use reflect to execute work")
                if counts["open"] >= MAX_OPEN:
                    raise RuntimeError(f"{MAX_OPEN} tasks are unresolved; review and resolve some first")
                if counts["running"] >= _max_running(parent):
                    raise RuntimeError(f"{_max_running(parent)} tasks are already running (the running limit); end your turn and "
                                       "dispatch more after you are woken by a finished task")
                if reuse is not None:
                    reused = _owned(parent, reuse)
                    current = _task_of_child(reused["child"])
                    if not current["resolved"]:
                        raise RuntimeError(f"the session of task {reuse} is in use by unresolved task "
                                           f"{current['id']}; resolve it first")
                    if current.get("worktree") and current.get("worktree_removed"):
                        raise RuntimeError(f"the worktree of task {current['id']} was removed; dispatch a new task")
                    reused = current
                    try:
                        child = sessions.get(reused["child"], light=True)
                    except Exception:
                        child = None
                    if not child:
                        raise RuntimeError(f"the session of task {reuse} no longer exists; dispatch a new task")
                else:
                    child = sessions.create(parent_id=parent, title=title, workspace=workspace)
        except Exception:
            if worktree:
                try:
                    _remove_worktree({"worktree": worktree[4], "repo": worktree[2]})
                    _git(worktree[2], "branch", "-D", worktree[1])
                except Exception:
                    log.warning("conductor: could not clean up worktree %s", worktree[0], exc_info=True)
            raise
        with lock:
            task = {"id": task_id, "parent": parent, "child": child["id"],
                    "title": title, "objective": objective, "created": time.time(), "runs": 0,
                    "stage": _progress(parent)["stage"],
                    "workspace": child.get("workspace") or workspace or ""}
            if worktree:
                task.update(worktree=worktree[4], branch=worktree[1], repo=worktree[2], base=worktree[3])
            if reused is not None:
                task.update(reused_from=reused["id"], workspace=reused.get("workspace") or task["workspace"])
                if reused.get("worktree"):  # shared with the earlier task; removed only once all are resolved
                    task.update({k: reused[k] for k in ("worktree", "branch", "repo", "base") if k in reused})
            tasks[task["id"]] = task
            try:
                _apply_selection(task, *_selection(parent, model, effort))
                _start(task, objective)
                _progress(parent).update(status="waiting_children", reason="")
            except Exception as error:
                failed = error
                task.update(status="error", error=str(error), finished=time.time(), result="",
                            review="pending", basis="", resolved=False, acked=True, notified=True)
        _publish()
        if failed is not None:
            raise RuntimeError(f"task {task['id']} could not be started: {failed}")
        return {"task": _public(task), **_counts(parent)}

    def collect(body):
        """Return finished, not yet collected tasks. Never blocks: the parent is
        woken by ``run.finished`` instead of waiting inside a turn."""
        parent = _sid(body)
        with lock:
            children = _children(parent)
            ready = [t for t in children if t["status"] in TERMINAL and not t.get("acked")]
            for task in ready:
                task["acked"] = task["notified"] = True
            result = {"finished": [_public(t) for t in ready],
                      "running": [_public(t) for t in _children(parent) if t["status"] == "running"],
                      "wait": not ready,
                      "next_action": "review" if ready else "end_turn",
                      **_counts(parent)}
        if ready:
            _publish()
        return result

    def tasks_op(body):
        parent = _sid(body)
        with lock:
            return {"tasks": [_public(t) for t in _children(parent)], **_counts(parent)}

    def inspect(body):
        parent = _sid(body)
        with lock:
            task = _owned(parent, body.get("task_id"))
            out = _public(task, full=True)
        try:
            out["recent_runs"] = [{k: r.get(k) for k in ("id", "status", "source", "created")}
                                  for r in runs.listing(task["child"], limit=5)]
        except Exception:
            pass
        return {"task": out}

    def detail(body):
        """Full text fields of one task for the web panel (the snapshot carries previews)."""
        parent = _sid(body)
        with lock:
            task = _owned(parent, body.get("task_id"))
            task = store.full_task(task)
            out = {"id": task["id"], "objective": task["objective"], "basis": task.get("basis") or ""}
            if task.get("status") in TERMINAL:
                out["result"] = task.get("result", "")
                out["error"] = task.get("error") or ""
        return {"task": out}

    def instruct(body):
        parent = _sid(body)
        text = _text(body, "instruction")
        model, effort = _requested(body)
        with lock:
            task = _owned(parent, body.get("task_id"))
            out = _instruct(parent, task, text, model, effort)
        _publish()
        return out

    def _instruct(parent, task, text, model=None, effort=None):
        # Caller holds the lock and publishes.
        if task["resolved"]:
            raise RuntimeError("task is resolved; dispatch a new task instead")
        if task["status"] == "running":
            if model or effort:
                raise RuntimeError("the task is running; its model can only change for a follow-up run "
                                   "after it finishes (or cancel it first)")
            try:
                ok = runs.push(task["run_id"], "steer", {"id": "c" + uuid.uuid4().hex[:10], "text": text})
            except Exception:
                ok = False
            if ok:
                return {"delivered": "steered into the running task at its next turn boundary"}
            raise RuntimeError("the running task could not take the instruction; retry after it finishes")
        if sum(t["status"] == "running" for t in _children(parent)) >= _max_running(parent):
            raise RuntimeError(f"{_max_running(parent)} tasks are already running; send this "
                               "instruction after you are woken by a finished task")
        _apply_selection(task, model, effort)
        _start(task, text)
        return {"delivered": "started a follow-up run in the task session", "task": _public(task)}

    def cancel(body):
        parent = _sid(body)
        with lock:
            task = _owned(parent, body.get("task_id"))
            run_id = task.get("run_id") if task["status"] == "running" else None
        if run_id:
            runs.cancel(run_id)
        return {"task": _public(task), "cancelling": bool(run_id)}

    def _task_ids(body):
        ids = body.get("task_ids")
        if ids is None:
            ids = [body.get("task_id")]
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i for i in ids):
            raise ValueError("task_id or a non-empty task_ids list is required")
        return list(dict.fromkeys(ids))

    def _close(task):
        if task["status"] not in TERMINAL:
            raise RuntimeError("task is still running")
        if task.get("review") == "pending":
            raise RuntimeError("review the task first (conductor_review with a basis)")
        if task["status"] == "done" and task.get("review") != "verified":
            raise RuntimeError("a finished task must be reviewed as 'verified' before resolving "
                               "(or continue it with needs_work + instruction)")
        task["resolved"] = task["acked"] = task["notified"] = True

    def review(body):
        """Record one verdict for one or more finished tasks. Optional follow-ups in the
        same call: ``resolve`` closes them, ``instruction`` (needs_work only) continues them."""
        parent = _sid(body)
        verdict = body.get("verdict")
        if verdict not in VERDICTS:
            raise ValueError("verdict must be 'verified' or 'needs_work'")
        basis = _text(body, "basis", limit=4000)
        ids = _task_ids(body)
        close = body.get("resolve") is True
        instruction = _text(body, "instruction", required=False)
        if instruction and verdict != "needs_work":
            raise ValueError("instruction is only allowed with verdict 'needs_work'")
        if close and instruction:
            raise ValueError("a task cannot be resolved and continued at once")
        results = []
        with lock:
            owned = [_owned(parent, i) for i in ids]
            for task in owned:
                if task["status"] not in TERMINAL:
                    raise RuntimeError(f"task {task['id']} is still running; review it after it finishes")
                if task["resolved"]:
                    raise RuntimeError(f"task {task['id']} is already resolved")
            for task in owned:
                task["review"], task["basis"] = verdict, basis
                task["acked"] = task["notified"] = True
                item = {"id": task["id"], "review": verdict}
                try:
                    if close:
                        _close(task)
                        item["resolved"] = True
                    elif instruction:
                        item["delivered"] = _instruct(parent, task, instruction)["delivered"]
                except Exception as error:
                    item["error"] = str(error)
                item["status"] = task["status"]
                results.append(item)
            counts = _counts(parent)
        _publish()
        return {"reviewed": results, **counts}

    def resolve(body):
        parent = _sid(body)
        ids = _task_ids(body)
        with lock:
            owned = [_owned(parent, i) for i in ids]
            for task in owned:
                try:
                    _close(task)
                except RuntimeError as error:
                    raise RuntimeError(f"task {task['id']}: {error}") from None
            counts = _counts(parent)
        removed, kept = [], []
        if body.get("remove_worktree"):
            for task in owned:
                if not task.get("worktree") or task.get("worktree_removed"):
                    continue
                with lock:
                    sharing = [t for t in tasks.values() if t is not task and t.get("worktree") == task["worktree"]]
                if any(not t["resolved"] for t in sharing):
                    kept.append(task["id"])  # a later task reusing this session still works in it
                    continue
                try:
                    _remove_worktree(task)
                    for other in sharing:
                        other["worktree_removed"] = True
                    removed.append(task["id"])
                except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                    log.warning("conductor: could not remove worktree of %s: %s", task["id"], error)
                    kept.append(task["id"])
            if removed:
                with lock:
                    store.save()
        _publish()
        out = {"resolved": [t["id"] for t in owned], **counts}
        if removed or kept:
            out.update(worktrees_removed=removed, worktrees_kept=kept)
        return out

    def toggle(body):
        sid = _sid(body)
        on = body.get("enabled")
        if not isinstance(on, bool):
            raise ValueError("enabled must be a boolean")
        with lock:
            if on and _task_of_child(sid) is not None:
                raise RuntimeError("a conductor task session cannot become a conductor")
            if on:
                enabled[sid] = True
            else:
                enabled.pop(sid, None)
                reflections.stop_parent(sid)
                auto.pop(sid, None)
                if not active.get(sid):
                    _cancel_continue(sid)
                if _progress(sid).get("status") in ("waiting_children", "waiting_external"):
                    _progress(sid).update(status="active", reason="")
        _publish()
        if on:
            _schedule_wake(sid)
        return {"enabled": on}

    def set_active(body):
        """Switch autopilot mode for a non-worker session: when on, the session is prompted
        to continue whenever its turn ends with the work neither finished nor blocked."""
        sid = _sid(body)
        on = body.get("active")
        if not isinstance(on, bool):
            raise ValueError("active must be a boolean")
        resume_now = False
        with lock:
            if on and _task_of_child(sid) is not None:
                raise RuntimeError("a conductor task session cannot enable autopilot")
            _cancel_continue(sid)
            plan = _progress(sid)
            plan.pop("next_continue_at", None)
            if on:
                was_idle_backoff = plan.get("status") == "idle_backoff"
                active[sid] = True
                if plan.get("status") in ("paused", "idle_backoff"):
                    plan.update(status="active", reason="")
                resume_now = was_idle_backoff and not runs.active_for(sid)
            else:
                active.pop(sid, None)
                if plan.get("status") == "idle_backoff":
                    plan.update(status="active", reason="")
            auto.pop(sid, None)
        _publish()
        if resume_now:
            _schedule_continue(sid, CONTINUE_DELAY)
        return {"active": on}

    def checkpoint(body):
        """Explicit durable handoff; reading/updating a plan is not execution progress."""
        parent = _sid(body)
        action = body.get("action", "get")
        if action not in ("get", "update", "advance"):
            raise ValueError("action must be get, update or advance")
        updates = {key: _text(body, key, required=False, limit=4000)
                   for key in ("goal", "next_step", "reason") if key in body}
        status = body.get("status")
        if status is not None and status not in ("active", "waiting_children", "waiting_external"):
            raise ValueError("use finish for done/blocked; status must be active or a waiting state")
        with lock:
            is_conductor = bool(enabled.get(parent))
            if not is_conductor:
                if action == "advance":
                    raise RuntimeError("stage advance requires conductor mode")
                if status in ("waiting_children", "waiting_external"):
                    raise RuntimeError("waiting states require conductor mode")
            state = _progress(parent)
            counts = _counts(parent)
            if action == "advance":
                if counts["open"] or counts["running"]:
                    raise RuntimeError("review and resolve every task before advancing the stage")
                handoff = _text(body, "handoff", limit=4000)
                next_step = _text(body, "next_step", limit=4000)
                goal = updates.get("goal", state.get("goal"))
                if not goal:
                    raise ValueError("goal is required before advancing the stage")
                history = [*state.get("history", []),
                           {"stage": state["stage"], "handoff": handoff, "finished": time.time()}]
                state.pop("next_continue_at", None)
                state.update(stage=state["stage"] + 1, history=history[-STAGE_HISTORY:],
                             goal=goal, next_step=next_step, status="active", reason="")
            elif action == "update":
                if status == "waiting_children" and not counts["running"]:
                    raise RuntimeError("no child is running; choose an actionable next step")
                if status == "waiting_external":
                    reason = updates.get("reason", state.get("reason"))
                    sources = reflections.listing(parent)
                    if not reason or not any(r.get("status") not in TERMINAL + ("stopped",) for r in sources):
                        raise RuntimeError("waiting_external needs a reason and a live reflect event source")
                state.update(updates)
                if status is not None:
                    state["status"] = status
            out = _counts(parent)
        if action != "get":
            _publish()
        return out

    def finish(body):
        """The conductor declares the user's request done or blocked; active mode then
        stops prompting it until the user sends another message."""
        parent = _sid(body)
        status = body.get("status")
        if status not in ("done", "blocked"):
            raise ValueError("status must be 'done' or 'blocked'")
        with lock:
            counts = _counts(parent)
            if status == "done" and (counts["running"] or counts["awaiting_review"]):
                raise RuntimeError(
                    "cannot finish as done: %d task(s) still running, %d awaiting review; "
                    "collect and review them first, or finish as blocked with the reason"
                    % (counts["running"], len(counts["awaiting_review"])))
            _cancel_continue(parent)
            auto.setdefault(parent, {})["finished"] = True
            plan = _progress(parent)
            plan.pop("next_continue_at", None)
            plan.update(status=status, reason=body.get("reason") or "")
        _publish()
        return {"finished": status, "active": bool(active.get(parent))}

    def set_limit(body):
        """Change this conductor session's own running (concurrency) limit. Lowering it
        never stops running tasks; it only blocks new starts until fewer are running."""
        parent = _sid(body)
        value = body.get("running")
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= RUNNING_CAP:
            raise ValueError(f"running must be an integer from 1 to {RUNNING_CAP}")
        with lock:
            previous = _max_running(parent)
            if value == MAX_RUNNING:
                overrides.pop(parent, None)
            else:
                overrides[parent] = {"running": value}
            counts = _counts(parent)
        _publish()
        out = {"previous": previous, **counts}
        if counts["running"] > value:
            out["note"] = (f"{counts['running']} tasks are running, above the new limit; they keep "
                           "running and no new task starts until fewer than the limit are running")
        return out

    def models_op(body):
        """Configured models, the conductor's own selection and its model policy."""
        parent = _sid(body)
        rows = _catalog()
        own_model, own_effort = _parent_selection(parent)
        with lock:
            policy = policies.get(parent)
            default = dict(defaults.get(parent) or {})
        model, effort = _selection(parent)
        view = lambda sel, eff: {"model": (sel or {}).get("model"), "model_key": (sel or {}).get("model_key"),
                                 "effort": eff}
        return {"models": [{"key": r.get("key"), "name": r["name"], "model": r.get("model"),
                            "provider": r.get("provider")} for r in rows] if rows is not None else None,
                "efforts": list(EFFORTS),
                "conductor": view(own_model, own_effort),
                "default": view(_stored(default), default.get("effort")),
                "effective_default": view(model, effort),
                "policy": policy}

    def set_policy(body):
        """Set this conductor's model-selection policy: free text added to its system
        prompt (which models/efforts to use for which kinds of task). Empty clears it."""
        parent = _sid(body)
        text = body.get("policy")
        if text is not None and not isinstance(text, str):
            raise ValueError("policy must be text")
        text = (text or "").strip()
        if len(text) > POLICY_MAX:
            raise ValueError(f"policy is too long ({len(text)} > {POLICY_MAX} characters)")
        with lock:
            previous = policies.get(parent)
            if text:
                policies[parent] = text
            else:
                policies.pop(parent, None)
        _publish()
        return {"previous": previous, "policy": text or None,
                "note": "added to your system prompt from your next turn on; follow it from now"
                        if text else "policy cleared"}

    def set_default(body):
        """Set this conductor's default model/effort for new tasks. "inherit" (or null)
        for a field clears it so tasks follow the conductor's own choice again."""
        parent = _sid(body)
        if "model" not in body and "effort" not in body:
            raise ValueError("give model and/or effort")
        updates = {}
        for key, check in (("model", _model_name), ("effort", _effort)):
            if key not in body:
                continue
            value = body.get(key)
            if value is None or (isinstance(value, str) and value.strip().lower() in ("", "inherit", "default")):
                updates[key] = None
            else:
                updates[key] = check(value)
        with lock:
            previous = dict(defaults.get(parent) or {})
            default = dict(previous)
            for key, value in updates.items():
                if key == "model":
                    default.pop("model_key", None)
                if value is None:
                    default.pop(key, None)
                elif key == "model":
                    default.update({k: v for k, v in value.items() if v})
                else:
                    default[key] = value
            if default:
                defaults[parent] = default
            else:
                defaults.pop(parent, None)
        _publish()
        out = models_op({"session_id": parent})
        out.pop("models", None)
        out["previous"] = {"model": previous.get("model"), "model_key": previous.get("model_key"),
                           "effort": previous.get("effort")}
        out["note"] = "applies to tasks dispatched from now on; running tasks keep their model"
        return out

    def reflect(body):
        _sid(body)
        if body.get("action", "list") == "start":
            _require_parent(body)
        return reflections.operation(body)

    OPS = {"reflect": reflect, "set_default": set_default, "set_limit": set_limit, "models": models_op, "set_policy": set_policy, "dispatch": dispatch, "collect": collect, "tasks": tasks_op, "inspect": inspect,
           "instruct": instruct, "cancel": cancel, "review": review, "resolve": resolve,
           "finish": finish, "checkpoint": checkpoint}
    # Operations that count as progress for active mode (reads and settings do not).
    PROGRESS_OPS = {"dispatch", "instruct", "cancel", "review", "resolve"}

    AUTOPILOT_OPS = {"checkpoint", "finish"}

    def _require_parent(body):
        with lock:
            if not enabled.get(body.get("session_id")):
                raise RuntimeError("conductor mode is off for this session")

    def _require_autopilot_or_parent(body):
        with lock:
            sid = body.get("session_id")
            if not enabled.get(sid) and not active.get(sid):
                raise RuntimeError("autopilot and conductor mode are off for this session")

    def rpc(body, call=None):
        body = body if isinstance(body, dict) else {}
        name = body.get("op")
        if name == "role":
            return role(body)
        op = OPS.get(name)
        if op is None:
            raise ValueError("unknown conductor operation")
        if name in AUTOPILOT_OPS:
            _require_autopilot_or_parent(body)
        else:
            _require_parent(body)
        def fingerprint():
            # No-op reviews/resolves must not keep active mode alive forever.
            return tuple((t["id"], t.get("run_id"), t["status"], t.get("review"),
                          t.get("resolved"), t.get("runs", 0)) for t in _children(_sid(body)))
        with lock:
            before = fingerprint() if name in PROGRESS_OPS else None
        result = op(body)
        if name in PROGRESS_OPS:
            with lock:
                if fingerprint() != before or (name == "instruct" and result.get("steered")):
                    state = auto.setdefault(_sid(body), {})
                    state["ops"] = state.get("ops", 0) + 1
        return result

    # ---- wake the parent when children finish ----------------------------
    def _schedule_wake(parent, delay=WAKE_COALESCE):
        # One cancellable timer per parent. A new event can advance a backoff
        # timer, but the persisted delivery deadline still gates submission.
        with lock:
            if reflections.closed:
                return
            due = time.time() + max(0, delay)
            previous = scheduled.get(parent)
            if previous and previous[0] <= due:
                return
            if previous:
                previous[1].cancel()

            def fire():
                with lock:
                    if scheduled.get(parent, (None, None))[1] is not timer:
                        return
                    scheduled.pop(parent, None)
                _wake(parent)

            timer = threading.Timer(max(0, delay), fire)
            timer.name, timer.daemon = "conductor-wake", True
            scheduled[parent] = (due, timer)
            timer.start()

    def _retry_delivery(item, error):
        attempts = item.get("attempts", 0) + 1
        delay = min(300, WAKE_RETRY_DELAY * 2 ** min(attempts - 1, 6))
        item.update(attempts=attempts, error=str(error), retry_at=time.time() + delay)
        store.save()
        _schedule_wake(item["parent"], delay)

    def _wake_reflection(parent):
        with lock:
            if (reflections.closed or not enabled.get(parent) or parent in waking
                    or runs.active_for(parent) or _unreported(parent)):
                return
            # Reflections never jump ahead of queued user input.
            peek = ctx.get("run_queue.peek")
            if callable(peek) and peek(parent) is not None:
                return
            item = reflections.ready(parent)
            if item is None:
                return
            text = reflections.claim(item)
            waking.add(parent)
        delay = 0.05
        try:
            code, reply = frontend.submit(text, session_id=parent, source=REFLECT_SOURCE)
            if code >= 400:
                raise RuntimeError((reply or {}).get("error") or "run could not be started")
            run_id = (reply or {}).get("run_id")
            if not run_id:
                raise RuntimeError("wake submission returned no run_id")
        except Exception as error:
            log.warning("conductor: could not deliver reflection to %s: %s", parent, error)
            with lock:
                reflections.failed(item, error, WAKE_RETRIES, WAKE_RETRY_DELAY)
            delay = WAKE_RETRY_DELAY
        else:
            with lock:
                reflections.submitted(item, run_id)
        finally:
            with lock:
                waking.discard(parent)
            _publish()
            # Also covers a run that finishes before submit returns.
            _schedule_wake(parent, delay)

    def _wake(parent):
        with lock:
            if reflections.closed or not enabled.get(parent) or parent in waking:
                return
            key = f"{parent}:wake"
            item = deliveries.get(key)
            pending = _unreported(parent)
            if not item and pending:
                # Persist the intent before crossing the submit boundary. Freeze
                # payload + task run ids: later completions belong to another item.
                still = sum(t["status"] == "running" for t in _children(parent))
                lines, details = [], []
                for t in pending:
                    lines.append(f"- {t['id']} · {t['title']} · {t['status']}")
                    body = _clip(t.get("result"), WAKE_RESULT_LIMIT) or "(no final delivery)"
                    if not t.get("result_complete"):
                        body = "INCOMPLETE DELIVERY: request a final report; do not verify from tool output.\n" + body
                    if len(t.get("result") or "") > WAKE_RESULT_LIMIT:
                        body = "TRUNCATED DELIVERY: inspect if evidence needed for review is missing.\n" + body
                    if t.get("error"):
                        body = f"error: {t['error']}\n" + body
                    if t.get("failure_kind"):
                        body = f"failure_kind={t['failure_kind']}; retryable={t.get('retryable', False)}\n" + body
                    if t.get("branch"):
                        body = f"branch {t['branch']} (inspect changes before review)\n" + body
                    details.append(f"=== {t['id']} result ===\n" + "\n".join("> " + x for x in body.splitlines()))
                item = {
                    "id": uuid.uuid4().hex, "parent": parent, "kind": "wake", "attempts": 0,
                    "created": min(t.get("finished") or 0 for t in pending),
                    "tasks": [{"id": t["id"], "run_id": t.get("run_id")} for t in pending],
                    "text": ("[Conductor] Delegated task(s) finished:\n" + "\n".join(lines)
                             + f"\n{still} task(s) still running.\n\n" + "\n\n".join(details)
                             + "\n\nReview these in this turn with conductor_review (task_ids for several at once; "
                               "resolve=true to close verified ones, or needs_work + instruction to continue). "
                               "Use conductor_inspect if evidence is missing. Retry infrastructure failures "
                               "without treating them as a rejected delivery."),
                    "metadata": {"conductor": {"kind": "wake", "tasks": [
                        {k: t.get(k) for k in ("id", "title", "status", "failure_kind", "retryable")}
                        for t in pending], "running": still}},
                }
                deliveries[key] = item
            if item:
                if not store.save():
                    _schedule_wake(parent, WAKE_RETRY_DELAY)
                    return
                remaining = item.get("retry_at", 0) - time.time()
                if remaining > 0:
                    _schedule_wake(parent, remaining)
                    return
                # A busy session or earlier user queue is not a failed delivery.
                # Keep a fallback timer as well as the run-finished callback.
                peek = ctx.get("run_queue.peek")
                queued = peek(parent) if callable(peek) else None
                if runs.active_for(parent) or (queued is not None and queued < item["created"]):
                    _schedule_wake(parent, WAKE_RETRY_DELAY)
                    return
                waking.add(parent)
        if not item:
            _wake_reflection(parent)
            return
        try:
            code, reply = frontend.submit(item["text"], session_id=parent, source=SOURCE,
                                          request_id=item["id"], metadata=item["metadata"])
            run_id = (reply or {}).get("run_id")
            if code >= 400 or not run_id:
                raise RuntimeError((reply or {}).get("error") or "wake submission returned no run_id")
        except Exception as error:
            log.warning("conductor: could not wake %s: %s", parent, error)
            with lock:
                _retry_delivery(item, error)
        else:
            with lock:
                # Ack only this generation, after the run is durably accepted.
                # If this save fails, the disk still contains the same request id;
                # Runs.start will return the original run on restart, not repeat it.
                for ref in item["tasks"]:
                    task = tasks.get(ref["id"])
                    if task and task.get("run_id") == ref.get("run_id"):
                        task.update(notified=True, acked=True, notified_run_id=run_id)
                deliveries.pop(key, None)
                store.save()
                _schedule_wake(parent, 0.05)
        finally:
            with lock:
                waking.discard(parent)
            _publish()

    # ---- keep the parent going when its turn ends early -------------------
    def _unreported(parent):
        return [t for t in _children(parent)
                if t["status"] in TERMINAL and not t.get("acked") and not t.get("notified")]

    def _note_parent_run(parent, record, message=None):
        """A conductor or autopilot session's own run ended (lock held): return continuation delay or None."""
        state = auto.setdefault(parent, {})
        ops = state.pop("ops", 0)
        finished = state.pop("finished", False)  # conductor_finish / autopilot_finish called
        asked_user, tool_progress = _message_tool_flags(message)
        by_user = record.get("source") not in {SOURCE, REFLECT_SOURCE}
        if record.get("source") == REFLECT_SOURCE:
            return None  # reflection cadence, not active-mode continuation, owns this turn
        _cancel_continue(parent)
        if by_user:
            state["idle"] = 0
            state.pop("nudged", None)
            plan = _progress(parent)
            plan.pop("next_continue_at", None)
            if not finished and plan.get("status") in ("done", "blocked", "paused", "idle_backoff"):
                plan.update(status="active", reason="")
        status = record.get("status") or "done"
        if (status == "error" and not finished and active.get(parent)
                and _failure(record, message)["retryable"]):
            # The model was unreachable. Prompting again right away only repeats the
            # failure, and stopping for good would strand an unattended session.
            plan = _progress(parent)
            if plan.get("status") in ("done", "blocked", "paused"):
                return None
            if enabled.get(parent) and (_counts(parent)["running"] or _unreported(parent)):
                return None  # a wake-up is already on its way
            due = time.time() + ACTIVE_IDLE_INTERVAL
            plan.update(status="idle_backoff",
                        reason="model unavailable; retrying every 30 minutes",
                        next_continue_at=due)
            log.info("conductor: model call failed for %s; retrying in 30m", parent)
            return ACTIVE_IDLE_INTERVAL
        if status != "done" or finished:
            return None  # stopped, failed, or declared done/blocked: leave it to the user
        if asked_user:
            plan = _progress(parent)
            plan.pop("next_continue_at", None)
            plan.update(status="blocked", reason="waiting for user answer")
            return None
        if not enabled.get(parent):
            if not active.get(parent):
                return None
            plan = _progress(parent)
            if not by_user and plan.get("status") in ("done", "blocked", "paused"):
                return None
            if ops or tool_progress:
                state["idle"] = 0
                plan.pop("next_continue_at", None)
                if plan.get("status") == "idle_backoff":
                    plan.update(status="active", reason="")
            elif not by_user:
                state["idle"] = state.get("idle", 0) + 1
            if state.get("idle", 0) >= ACTIVE_IDLE_LIMIT:
                due = time.time() + ACTIVE_IDLE_INTERVAL
                plan.update(status="idle_backoff",
                            reason="no progress; retrying every 30 minutes",
                            next_continue_at=due)
                log.info("conductor: autopilot entering 30m idle backoff for %s after %d turns without tool progress",
                         parent, state["idle"])
                return ACTIVE_IDLE_INTERVAL
            return CONTINUE_DELAY
        counts = _counts(parent)
        if counts["running"] or _unreported(parent):
            plan = _progress(parent)
            plan.pop("next_continue_at", None)
            if ops:
                state["idle"] = 0
            plan.update(status="waiting_children", reason="")
            return None  # a wake-up is already on its way
        plan = _progress(parent)
        if not by_user and plan.get("status") in ("done", "blocked", "paused"):
            return None
        if plan.get("status") == "waiting_external":
            if any(r.get("status") not in TERMINAL + ("stopped",) for r in reflections.listing(parent)):
                return None
            plan.pop("next_continue_at", None)
            plan.update(status="active", reason="external source ended; choose the next action")
        awaiting = set(counts["awaiting_review"])
        if not active.get(parent):
            # Not in active mode: only remind once about results left unreviewed.
            if not awaiting or awaiting <= state.get("nudged", set()):
                return None
            state["nudged"] = awaiting
            return CONTINUE_DELAY
        if ops:
            state["idle"] = 0
            plan.pop("next_continue_at", None)
            if plan.get("status") == "idle_backoff":
                plan.update(status="active", reason="")
        elif not by_user:
            state["idle"] = state.get("idle", 0) + 1
        if state.get("idle", 0) >= ACTIVE_IDLE_LIMIT:
            due = time.time() + ACTIVE_IDLE_INTERVAL
            plan.update(status="idle_backoff",
                        reason="no task progress; retrying every 30 minutes",
                        next_continue_at=due)
            log.info("conductor: active mode entering 30m idle backoff for %s after %d turns without a task operation",
                     parent, state["idle"])
            return ACTIVE_IDLE_INTERVAL
        return CONTINUE_DELAY

    def _schedule_continue(parent, delay=CONTINUE_DELAY):
        due = time.time() + max(0.0, delay)
        with lock:
            if reflections.closed or (not enabled.get(parent) and not active.get(parent)):
                return
            old = continued.get(parent)
            if old:
                old[1].cancel()

            def fire():
                with lock:
                    if continued.get(parent, (None, None))[1] is not timer:
                        return
                    continued.pop(parent, None)
                _continue(parent)

            timer = threading.Timer(max(0.0, delay), fire)
            timer.name, timer.daemon = "conductor-continue", True
            continued[parent] = (due, timer)
            timer.start()

    def _continue(parent):
        in_backoff = False
        reschedule_busy = False
        with lock:
            is_conductor = bool(enabled.get(parent))
            is_active = bool(active.get(parent))
            if reflections.closed or (not is_conductor and not is_active):
                return
            prog = dict(_progress(parent) or {})
            in_backoff = is_active and prog.get("status") == "idle_backoff"
            if parent in waking or runs.active_for(parent):
                if in_backoff:
                    due = time.time() + WAKE_RETRY_DELAY
                    _progress(parent)["next_continue_at"] = due
                    reschedule_busy = True
                else:
                    return
            if not reschedule_busy:
                peek = ctx.get("run_queue.peek")
                if callable(peek) and peek(parent) is not None:
                    return  # the user's queued message goes first
                if prog.get("status") in ("done", "blocked", "paused", "waiting_external"):
                    return  # a delayed continuation must respect a newer explicit state
                awaiting = []
                if is_conductor:
                    counts = _counts(parent)
                    if counts["running"] or _unreported(parent) or reflections.ready(parent):
                        return
                    awaiting = counts["awaiting_review"]
                    if not is_active and not awaiting:
                        return
                waking.add(parent)
        if reschedule_busy:
            _publish()
            _schedule_continue(parent, WAKE_RETRY_DELAY)
            return
        backoff_note = (
            " No concrete progress was made in the recent turns, so continuation has backed off "
            "to every 30 minutes; make real progress now to resume normal pace, or call "
            f"{'conductor_finish' if is_conductor else 'autopilot_finish'} immediately if the "
            "work is already done or blocked on the user."
        ) if in_backoff else ""
        if is_conductor:
            review = (f"Task(s) still awaiting your review: {', '.join(awaiting)}. Review them with "
                      "conductor_review (resolve=true to close verified ones).") if awaiting else ""
            if is_active:
                text = ("[Conductor] Active mode: your turn ended without conductor_finish, and no "
                        "delegated task is running. " + (review + " " if review else "")
                        + "Check what the user's request still needs and keep going: dispatch or "
                          "instruct tasks, verify results, and if you are waiting on external work, "
                          "dispatch a task that waits for it and reports back instead of stopping. When the "
                          "whole request is done and verified call conductor_finish(status='done'); "
                          "if you cannot continue without the user call "
                          f"conductor_finish(status='blocked', reason=...).{backoff_note}")
                metadata = {"conductor": {"kind": "active", "mode": "conductor",
                                          **({"idle_backoff": True} if in_backoff else {})}}
            else:
                text = "[Conductor] " + review
                metadata = {"conductor": {"kind": "review", "mode": "conductor"}}
        else:
            hint = " ".join(p for p in (
                f"Current goal: {prog['goal']}." if prog.get("goal") else "",
                f"Planned next step: {prog['next_step']}." if prog.get("next_step") else "",
            ) if p)
            text = ("[Autopilot] Your turn ended without autopilot_finish. "
                    + (hint + " " if hint else "")
                    + "Check what the user's goal still needs and keep executing and verifying "
                    "directly with your tools. Do not repeat pure status updates without action. "
                    "When the whole request is done and verified call autopilot_finish(status='done'); "
                    "if you cannot continue without the user call ask_user or "
                    f"autopilot_finish(status='blocked', reason=...).{backoff_note}")
            metadata = {"conductor": {"kind": "active", "mode": "autopilot",
                                      **({"idle_backoff": True} if in_backoff else {})}}
        try:
            code, reply = frontend.submit(text, session_id=parent, source=SOURCE, metadata=metadata)
            if code >= 400:
                raise RuntimeError((reply or {}).get("error") or "run could not be started")
        except Exception as error:
            log.warning("conductor: could not continue %s: %s", parent, error)
            if in_backoff and hasattr(frontend, "submit"):
                with lock:
                    if active.get(parent) and _progress(parent).get("status") == "idle_backoff":
                        due = time.time() + ACTIVE_IDLE_INTERVAL
                        _progress(parent)["next_continue_at"] = due
                _publish()
                _schedule_continue(parent, ACTIVE_IDLE_INTERVAL)
        finally:
            with lock:
                waking.discard(parent)
            if is_conductor:
                _schedule_wake(parent)

    def pending_since(parent):
        """Finish time of the oldest unreported child, else None (read by run-queue)."""
        with lock:
            if not enabled.get(parent):
                return None
            times = [t.get("finished") or 0 for t in _children(parent)
                     if t["status"] in TERMINAL and not t.get("acked") and not t.get("notified")]
            return min(times) if times else None

    def on_finished(data, nxt=None):
        try:
            sid, run_id = data.get("session_id"), data.get("run_id")
            record = data.get("run") or {}
            reflections.finished(sid, run_id, record, _message_text(data.get("message")))
            parent, continue_delay, handled_parent = None, None, False
            with lock:
                task = _task_of_child(sid) if sid else None
                if task is not None and task.get("run_id") == run_id and task["status"] == "running":
                    status = record.get("status") or "done"
                    task["status"] = status if status in TERMINAL else "done"
                    task["finished"] = time.time()
                    task.update(_message_result(data.get("message")))
                    if task["status"] != "done":
                        task["result_complete"] = False
                    task["error"] = record.get("error") or ""
                    task.update(_failure(record, data.get("message")))
                    metric = _task_metrics(record, data.get("message"))
                    task["metrics"] = metric
                    total = task.setdefault("total_metrics", {"seconds": 0, "turns": 0, "usage": {}})
                    total["seconds"] += metric["seconds"] or 0
                    total["turns"] += metric["turns"]
                    for key, value in metric["usage"].items():
                        total["usage"][key] = total["usage"].get(key, 0) + value
                    task["acked"] = task["notified"] = False
                    parent = task["parent"]
                    store.save()
                    changed.notify_all()
                elif sid and (enabled.get(sid) or active.get(sid)):
                    if enabled.get(sid):
                        parent = sid  # the parent went idle: deliver anything that finished meanwhile
                    continue_delay = _note_parent_run(sid, record, data.get("message"))
                    handled_parent = True
                    store.save()  # persist waiting/idle_backoff state even without a tool call
            if handled_parent:
                _publish()
            if parent:
                _schedule_wake(parent)
            if continue_delay is not None:
                _schedule_continue(sid, continue_delay)
        except Exception as error:
            log.warning("conductor: run.finished handling failed: %s", error)
        return nxt(data) if nxt else None

    def snapshot(data, nxt=None):
        try:
            current = data.get("session_id")
            with lock:
                data["conductor"] = {
                    "enabled": sorted(enabled),
                    "active": sorted(active),
                    # Only what the selected session's page shows: its own tasks, and
                    # whether it is itself a task session. Other conductors' tasks would
                    # ride along on every broadcast without ever being rendered.
                    "tasks": [_public(t, brief=True) for t in _children(current)
                              if enabled.get(current) or not t["resolved"]],
                    "children": {t["child"]: {"task_id": t["id"], "parent": t["parent"]}
                                 for t in sorted(tasks.values(), key=lambda t: t["created"])
                                 if current in (t["parent"], t["child"])},
                    "reflections": reflections.listing(current),
                    "limits": _limits(current),
                    "progress": _counts(current)["progress"],
                    "current": current,
                    "persistence_error": store.persistence_error or store.archive_error,
                    "deliveries": [{k: item.get(k) for k in ("id", "kind", "created", "attempts", "retry_at", "error")}
                                   for item in deliveries.values() if item.get("parent") == current]}
        except Exception:
            pass
        return nxt(data) if nxt else data

    def _route(fn, guard=True):
        def route(request):
            body = request.get("body") or {}
            try:
                if guard:
                    _require_parent(body)
                result = fn(body)
            except ValueError as error:
                return 400, {"error": str(error)}
            except RuntimeError as error:
                return 409, {"error": str(error)}
            return 200, {"ok": True, **(result or {})}
        return route

    reflections = Reflections(store.data["reflections"], store.path.parent / "conductor-reflect",
                              lock, _publish, _schedule_wake)
    store.save()  # persist interrupted sources after a host/plugin restart
    ctx.scope.add(runs.register_rpc("conductor", rpc))
    ctx.scope.add(runs.register_worker_plugin("conductor-worker"))
    ctx.scope.add(runs.register_worker_plugin("ga-steer"))
    ctx.on("web.snapshot", snapshot)
    ctx.provide("conductor.pending_since", pending_since)

    def is_enabled(sid):
        with lock:
            return bool(enabled.get(sid))

    def set_enabled(sid, on):
        return toggle({"session_id": sid, "enabled": bool(on)})["enabled"]

    def is_active(sid):
        with lock:
            return bool(active.get(sid))

    def set_active_mode(sid, on):
        return set_active({"session_id": sid, "active": bool(on)})["active"]
    # Per-session mode switch for other plugins (e.g. the channels /conductor command).
    ctx.provide("conductor.mode", SimpleNamespace(
        enabled=is_enabled, toggle=set_enabled, active=is_active, set_active=set_active_mode))
    ctx.on("run.finished", on_finished)
    script, style = HERE / "client.js", HERE / "client.css"
    ctx.scope.add(host.register("conductor", script=script if script.is_file() else None,
                                style=style if style.is_file() else None, order=36,
                                routes={("POST", "toggle"): _route(toggle, guard=False),
                                        ("POST", "active"): _route(set_active, guard=False),
                                        ("POST", "reflect"): _route(reflect, guard=False),
                                        ("POST", "task"): _route(detail, guard=False),
                                        ("POST", "cancel"): _route(cancel),
                                        ("POST", "resolve"): _route(resolve)}))
    def close():
        reflections.close()
        with lock:
            for _, timer in scheduled.values():
                timer.cancel()
            scheduled.clear()
            for _, timer in continued.values():
                timer.cancel()
            continued.clear()
            store.save()
    ctx.scope.add(close)
    # Recover terminal tasks and persisted delivery intents without requiring a
    # new user message. Disabled parents remain dormant until explicitly enabled.
    for parent in list(enabled):
        if _unreported(parent) or any(d.get("parent") == parent for d in deliveries.values()):
            _schedule_wake(parent)
    now = time.time()
    for sid in list(active):
        plan = progress.get(sid)
        if sid not in scheduled and isinstance(plan, dict) and plan.get("status") == "idle_backoff":
            due = plan.get("next_continue_at")
            delay = max(CONTINUE_DELAY, (due - now) if isinstance(due, (int, float)) else ACTIVE_IDLE_INTERVAL)
            _schedule_continue(sid, delay)
