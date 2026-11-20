"""swarm: mesh-style multi-session collaboration on a shared message board.

A swarm belongs to one *coordinator* session (the session where swarm mode is turned
on). Only the coordinator adds or removes *members*; every member is its own child
session with a role brief, optional model/effort and optional git worktree. All
participants talk through one board: ``@name``, ``@group`` and ``@all`` mentions wake
the mentioned participants (unlike conductor mode, members talk to each other
directly; the coordinator does not relay).

The host owns everything durable: swarms, members, posts, read cursors, wake queue,
concurrency limits, the ping-pong gate and the idle monitor that wakes the
coordinator once the board goes quiet. The worker half (``swarm-worker``) only exposes
tools and prompt text, talking to this plugin over the ``swarm`` RPC.

User messages sent directly to a member session are private: they run with the
ordinary user source and never appear on the board unless the member posts.
"""
from __future__ import annotations

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

log = logging.getLogger(__name__)
HERE = Path(__file__).resolve().parent
SOURCE = "swarm"
COORD = "coordinator"
RESERVED = {COORD, "all", "user", "system", "here", "everyone"}
NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
MENTION_RE = re.compile(r"(?<![\w@])@([A-Za-z][A-Za-z0-9_-]{0,31})")
MAX_TEXT = 20000
MAX_POSTS = 2000
SNAPSHOT_POSTS = 200
PINGPONG_WINDOW = 10
DEFAULTS = {"max_concurrent": 3, "global_max": 6, "idle_wake": 30,
            "max_auto_wakes": 60, "turn_timeout": 3600}


def _store_path(sessions):
    base = getattr(sessions, "path", None)
    return Path(base).with_name("swarm.json") if base else HERE / "swarm.json"


def _git(cwd, *args, timeout=60):
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    done = subprocess.run(["git", *args], cwd=cwd, capture_output=True, timeout=timeout,
                          creationflags=flags, stdin=subprocess.DEVNULL)
    out = done.stdout.decode("utf-8", "replace").strip()
    if done.returncode:
        err = done.stderr.decode("utf-8", "replace").strip() or out
        raise RuntimeError(f"git {args[0]} failed: {err[:500]}")
    return out


def _add_worktree(source, root, key, branch):
    """Fresh branch of the repository at ``source`` in its own directory.
    Returns (workdir, branch, repo top, base commit, worktree root)."""
    try:
        top = _git(source, "rev-parse", "--show-toplevel")
    except (OSError, RuntimeError) as error:
        raise ValueError(f"worktree needs a git repository: {source} ({error})") from None
    top = str(Path(top).resolve())
    base = _git(top, "rev-parse", "HEAD")
    target = Path(root) / key
    target.parent.mkdir(parents=True, exist_ok=True)
    _git(top, "worktree", "add", "-b", branch, str(target), base, timeout=300)
    src = Path(source).resolve()
    rel = src.relative_to(top) if src != Path(top) else Path()
    workdir = target / rel
    return str(workdir if workdir.is_dir() else target), branch, top, base, str(target)


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.persistence_error = None
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            data = {}
        except Exception as error:
            log.warning("swarm: cannot read %s: %s", self.path, error)
            data = {}
        self.data = {"swarms": data.get("swarms") if isinstance(data.get("swarms"), dict) else {}}

    def save(self):
        tmp = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".swarm-", suffix=".json", dir=str(self.path.parent))
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(self.data, fh, ensure_ascii=False)
            os.replace(tmp, self.path)
            tmp = None
            self.persistence_error = None
        except Exception as error:
            self.persistence_error = str(error)
            log.warning("swarm: cannot save %s: %s", self.path, error)
        finally:
            if tmp is not None:
                Path(tmp).unlink(missing_ok=True)


def _num(config, key):
    try:
        value = int((config or {}).get(key, DEFAULTS[key]))
    except (TypeError, ValueError):
        value = DEFAULTS[key]
    return max(1, value)


def apply(ctx, config):
    host, runs, sessions = ctx.get("web.host"), ctx.get("runs"), ctx.get("sessions")
    frontend = host.frontend
    lock = threading.RLock()
    changed = threading.Condition(lock)
    stop = threading.Event()
    store = Store(_store_path(sessions))
    swarms = store.data["swarms"]  # coordinator session id -> swarm
    settings = {k: _num(config, k) for k in DEFAULTS}

    # A host restart loses every live run: nothing is running any more.
    for sw in swarms.values():
        for m in _all_parts(sw):
            if m.get("status") == "running":
                m.update(status="idle", run_id=None)
        sw.setdefault("wakes", 0)

    # ---- helpers ---------------------------------------------------------
    def _sid(body, key="session_id"):
        sid = body.get(key)
        if not isinstance(sid, str) or not sid:
            raise ValueError(f"{key} is required")
        return sid

    def _text(body, key, required=True, limit=MAX_TEXT):
        value = body.get(key)
        if value is None or (isinstance(value, str) and not value.strip()):
            if required:
                raise ValueError(f"{key} is required")
            return ""
        if not isinstance(value, str):
            raise ValueError(f"{key} must be a string")
        value = value.strip()
        if len(value) > limit:
            raise ValueError(f"{key} is too long (max {limit} characters)")
        return value

    def _locate(sid):
        """(swarm, participant name) for a session, or (None, None)."""
        sw = swarms.get(sid)
        if sw is not None and sw.get("enabled"):
            return sw, COORD
        for sw in swarms.values():
            for m in sw["members"].values():
                if m["session"] == sid and not m.get("removed"):
                    return sw, m["name"]
        return None, None

    def _part(sw, name):
        return sw["coordinator"] if name == COORD else sw["members"].get(name)

    def _active_members(sw):
        return [m for m in sw["members"].values() if not m.get("removed")]

    def _groups(sw):
        out = {}
        for m in _active_members(sw):
            for g in m.get("groups") or []:
                out.setdefault(g, []).append(m["name"])
        return out

    def _public_member(m, brief=False):
        row = {k: m.get(k) for k in ("name", "role", "session", "groups", "model", "model_key",
                                     "effort", "status", "branch", "worktree", "removed",
                                     "runs", "started", "finished", "pending", "error")}
        if m.get("pending_settings"):
            row["pending_settings"] = dict(m["pending_settings"])
        if not brief:
            row["brief"] = m.get("brief", "")
        if m.get("status") == "running" and m.get("started"):
            row["elapsed"] = round(time.time() - m["started"], 1)
        return row

    def _roster(sw):
        return [{"name": m["name"], "role": m.get("role", ""), "groups": m.get("groups") or [],
                 "status": m.get("status", "idle"), "model": m.get("model")}
                for m in _active_members(sw)]

    def _publish():
        with lock:
            store.save()
            changed.notify_all()
        try:
            frontend.broadcast("snapshot", frontend.snapshot())
        except Exception:
            pass

    def _busy(sid):
        try:
            return bool(runs.active_for(sid))
        except Exception:
            return False

    def _running_total():
        return sum(p.get("status") == "running" for sw in swarms.values() for p in _all_parts(sw))

    # ---- models ----------------------------------------------------------
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
            log.warning("swarm: model catalog unavailable: %s", error)
            return None

    def _model(value):
        if value in (None, ""):
            return None
        if not isinstance(value, str):
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
                raise ValueError(f"model {value!r} is ambiguous; use its key: "
                                 + ", ".join(str(r.get("key")) for r in hit))
        raise ValueError(f"unknown model {value!r}; call swarm_models for the configured list")

    def _effort(value):
        if value in (None, ""):
            return None
        if not isinstance(value, str) or not re.fullmatch(r"[a-z]{2,12}", value.strip().lower()):
            raise ValueError("effort must be a reasoning level such as low, medium or high")
        return value.strip().lower()

    def _settings(body):
        """Model/effort changes from a request; a present but empty value resets to default."""
        values = {}
        if "model" in body:
            values.update(_model(body.get("model")) or {"model": None, "model_key": None})
        if "effort" in body:
            values["effort"] = _effort(body.get("effort"))
        if not values:
            raise ValueError("nothing to change: give model and/or effort")
        return values

    def _sync(p):
        """Mirror the session's own model/effort (it may change in the session itself)."""
        try:
            state = sessions.state_of(p["session"]) or {}
        except Exception:
            return
        for k in ("model", "model_key", "effort"):
            p[k] = state.get(k)

    def _apply_pending(p):
        """Apply settings queued while the member was running; True when nothing is left."""
        values = p.get("pending_settings")
        if not values:
            return True
        try:
            sessions.remember_for(p["session"], **values)
        except RuntimeError:
            return False
        except Exception:
            log.warning("swarm: applying settings for %s failed", p.get("name"), exc_info=True)
        p.pop("pending_settings", None)
        _sync(p)
        return True

    # ---- board -----------------------------------------------------------
    def _targets(sw, author, text):
        names = {m["name"] for m in _active_members(sw)}
        groups = _groups(sw)
        out = []
        for raw in MENTION_RE.findall(text):
            tag = raw.lower()
            if tag == "all":
                out += sorted(names) + [COORD]
            elif tag == COORD:
                out.append(COORD)
            elif tag in names:
                out.append(tag)
            elif tag in groups:
                out += groups[tag]
        return [t for t in dict.fromkeys(out) if t != author]

    def _add_post(sw, author, text, reply_to=None, kind="post", via=None):
        sw["seq"] = sw.get("seq", 0) + 1
        post = {"id": sw["seq"], "author": author, "text": text, "created": time.time(),
                "mentions": _targets(sw, author, text), "kind": kind}
        if reply_to:
            post["reply_to"] = reply_to
        if via:
            post["via"] = via
        sw["posts"].append(post)
        if len(sw["posts"]) > MAX_POSTS:
            del sw["posts"][:len(sw["posts"]) - MAX_POSTS]
        sw["last_activity"] = post["created"]
        return post

    def _pingpong(sw):
        """Two members bouncing mentions back and forth with nobody else involved."""
        tail = [p for p in sw["posts"] if p.get("kind") == "post"][-PINGPONG_WINDOW:]
        if len(tail) < PINGPONG_WINDOW:
            return None
        authors = {p["author"] for p in tail}
        if len(authors) != 2 or COORD in authors or "user" in authors:
            return None
        a, b = sorted(authors)
        if all(p["mentions"] == [({a, b} - {p["author"]}).pop()] for p in tail):
            return a, b
        return None

    def _pause(sw, reason):
        if sw.get("paused"):
            return
        sw["paused"] = reason
        note = _add_post(sw, "system", f"@coordinator Swarm paused: {reason}. Automatic member "
                         "wake-ups are held until you (or the user) post to the board.", kind="system")
        _queue(sw, COORD, note["id"])

    def _queue(sw, name, post_id):
        p = _part(sw, name)
        if p is None or p.get("removed"):
            return
        p["pending"] = max(p.get("pending") or 0, post_id)

    def _deliver(sw, post):
        if post["author"] in (COORD, "user"):
            sw["wakes"] = 0
            sw.pop("paused", None)
        for name in post["mentions"]:
            _queue(sw, name, post["id"])
        if post["author"] not in (COORD, "user", "system"):
            pair = _pingpong(sw)
            if pair:
                _pause(sw, f"@{pair[0]} and @{pair[1]} have exchanged {PINGPONG_WINDOW} posts in a row")

    def _wake_text(sw, name, upto):
        p = _part(sw, name)
        cursor = p.get("cursor") or 0
        posts = [x for x in sw["posts"] if x["id"] > cursor and x["id"] <= upto
                 and name in x["mentions"]][-5:]
        lines = []
        for x in posts:
            body = x["text"] if len(x["text"]) <= 1500 else x["text"][:1500] + " ..."
            lines.append(f"#{x['id']} @{x['author']}: {body}")
        head = ("[Swarm] You were mentioned on the board." if posts
                else "[Swarm] The board has news for you.")
        return (head + "\n" + "\n".join(lines) +
                "\nCatch up with board_read if needed, do your part, then board_post the result "
                "(mention only who must act) and end your turn.")

    def _start(sw, name, text):
        p = _part(sw, name)
        _apply_pending(p)
        _sync(p)
        record = runs.start(text, session_id=p["session"], source=SOURCE,
                            timeout=settings["turn_timeout"])
        p.update(status="running", run_id=record["id"], started=time.time(), finished=None, error="")
        p["runs"] = (p.get("runs") or 0) + 1

    def _pump():
        """Start queued wake-ups within the per-swarm and global limits."""
        started = False
        with lock:
            for sw in list(swarms.values()):
                if not sw.get("enabled") or sw.get("finished"):
                    continue
                parts = [sw["coordinator"]] + _active_members(sw)
                running = sum(p.get("status") == "running" for p in parts)
                for p in parts:
                    if not p.get("pending") or p.get("status") == "running":
                        continue
                    is_coord = p is sw["coordinator"]
                    if not is_coord and sw.get("paused"):
                        continue
                    if not is_coord and (running >= settings["max_concurrent"]
                                         or _running_total() >= settings["global_max"]):
                        continue
                    if not is_coord and sw.get("wakes", 0) >= settings["max_auto_wakes"]:
                        _pause(sw, f"{settings['max_auto_wakes']} automatic wake-ups without "
                                   "coordinator or user input")
                        continue
                    if _busy(p["session"]):
                        continue  # the user is talking to it; retry when that run ends
                    upto = p["pending"]
                    try:
                        _start(sw, COORD if is_coord else p["name"], _wake_text(sw, COORD if is_coord else p["name"], upto))
                    except Exception as error:
                        p["error"] = str(error)[:300]
                        log.warning("swarm: wake of %s failed: %s", p.get("name"), error)
                        continue
                    p["pending"] = 0
                    started = True
                    if not is_coord:
                        running += 1
                        sw["wakes"] = sw.get("wakes", 0) + 1
        if started:
            _publish()

    def _monitor():
        """Idle monitor: once nothing is running or queued, wake the coordinator once per
        board state so it can review, re-plan or finish."""
        while not stop.wait(2.0):
            try:
                wake = False
                with lock:
                    now = time.time()
                    for sid, sw in swarms.items():
                        if not sw.get("enabled") or sw.get("finished") or not _active_members(sw):
                            continue
                        parts = [sw["coordinator"]] + _active_members(sw)
                        if any(p.get("status") == "running" or p.get("pending") for p in parts):
                            continue
                        if any(_busy(p["session"]) for p in parts):
                            continue
                        if sw.get("idle_seq") == sw.get("seq", 0):
                            continue
                        if now - (sw.get("last_activity") or 0) < settings["idle_wake"]:
                            continue
                        sw["idle_seq"] = sw.get("seq", 0)
                        note = _add_post(sw, "system", "@coordinator The board is quiet: no member is "
                                         "running and nobody is waiting on a mention. Review the "
                                         "results, assign the next step, or call swarm_finish.", kind="system")
                        sw["idle_seq"] = sw["seq"]
                        _queue(sw, COORD, note["id"])
                        wake = True
                if wake:
                    _publish()
                _pump()
            except Exception:
                log.warning("swarm: monitor failed", exc_info=True)

    # ---- operations ------------------------------------------------------
    def _swarm_of(sid, coordinator=False):
        with lock:
            sw, name = _locate(sid)
        if sw is None:
            raise RuntimeError("this session is not part of an active swarm")
        if coordinator and name != COORD:
            raise RuntimeError("only the coordinator can do this")
        return sw, name

    def role(body, call=None):
        sid = _sid(body)
        with lock:
            sw, name = _locate(sid)
            if sw is None:
                return {"role": "none"}
            if name == COORD:
                return {"role": "coordinator", "name": COORD, "finished": bool(sw.get("finished")),
                        "paused": sw.get("paused"), "members": _roster(sw)}
            m = sw["members"][name]
            return {"role": "member", "name": name, "member_role": m.get("role", ""),
                    "brief": m.get("brief", ""), "groups": m.get("groups") or [],
                    "members": _roster(sw)}

    def post(body, call=None):
        sw, name = _swarm_of(_sid(body))
        text = _text(body, "text")
        reply_to = body.get("reply_to")
        reply_to = reply_to if isinstance(reply_to, int) and reply_to > 0 else None
        via = None
        if call is not None and getattr(call, "run_id", None):
            try:
                via = (runs.get(call.run_id) or {}).get("source")
            except Exception:
                via = None
        with lock:
            if sw.get("finished"):
                raise RuntimeError("the swarm is finished")
            item = _add_post(sw, name, text, reply_to, via=via if via and via != SOURCE else None)
            p = _part(sw, name)
            p["cursor"] = max(p.get("cursor") or 0, item["id"])
            _deliver(sw, item)
        _publish()
        _pump()
        return {"post": item, "woken": item["mentions"]}

    def _unread(sw, name, since, limit):
        p = _part(sw, name)
        cursor = p.get("cursor") or 0 if since is None else since
        items = [x for x in sw["posts"] if x["id"] > cursor][:limit]
        return items

    def read(body, call=None):
        sw, name = _swarm_of(_sid(body))
        since = body.get("since") if isinstance(body.get("since"), int) else None
        limit = body.get("limit") if isinstance(body.get("limit"), int) else 30
        limit = max(1, min(100, limit))
        with lock:
            items = _unread(sw, name, since, limit)
            p = _part(sw, name)
            if items:
                p["cursor"] = max(p.get("cursor") or 0, items[-1]["id"])
            more = sum(x["id"] > (items[-1]["id"] if items else (p.get("cursor") or 0)) for x in sw["posts"])
            store.save()
        return {"posts": items, "more": more, "cursor": p.get("cursor") or 0}

    def wait(body, call=None):
        sw, name = _swarm_of(_sid(body))
        try:
            timeout = max(10, min(900, int(body.get("timeout") or 300)))
        except (TypeError, ValueError):
            timeout = 300
        any_post = bool(body.get("any"))
        end = time.time() + timeout
        with lock:
            p = _part(sw, name)
            start = sw.get("seq", 0)
            while True:
                fresh = [x for x in sw["posts"] if x["id"] > start
                         and (any_post or name in x["mentions"])]
                if fresh:
                    break
                if sw.get("finished") or stop.is_set() or (call is not None and call.cancelled.is_set()):
                    break
                left = end - time.time()
                if left <= 0:
                    break
                changed.wait(min(left, 1.0))
            if fresh:
                p["cursor"] = max(p.get("cursor") or 0, fresh[-1]["id"])
                if name in fresh[-1]["mentions"] and (p.get("pending") or 0) <= fresh[-1]["id"]:
                    p["pending"] = 0  # already delivered by the wait itself
        return {"posts": fresh, "timed_out": not fresh, "finished": bool(sw.get("finished"))}

    def members(body, call=None):
        sw, _ = _swarm_of(_sid(body))
        with lock:
            return {"coordinator": _public_member(sw["coordinator"], brief=True),
                    "members": [_public_member(m) for m in _active_members(sw)],
                    "groups": _groups(sw), "paused": sw.get("paused")}

    def add(body, call=None):
        sw, _ = _swarm_of(_sid(body), coordinator=True)
        name = _text(body, "name", limit=32).lower()
        if not NAME_RE.match(name) or name in RESERVED:
            raise ValueError("name must be a short handle (a-z, digits, - _), not a reserved word")
        role_title = _text(body, "role", limit=200)
        brief = _text(body, "brief", required=False, limit=8000)
        groups = body.get("groups") or []
        if not isinstance(groups, list) or not all(isinstance(g, str) for g in groups):
            raise ValueError("groups must be a list of names")
        groups = list(dict.fromkeys(g.strip().lower().lstrip("@") for g in groups if g.strip()))
        for g in groups:
            if not NAME_RE.match(g) or g in RESERVED:
                raise ValueError(f"invalid group name {g!r}")
        model, effort = _model(body.get("model")), _effort(body.get("effort"))
        coord = sw["coordinator"]["session"]
        with lock:
            if sw.get("finished"):
                raise RuntimeError("the swarm is finished")
            if name in sw["members"] and not sw["members"][name].get("removed"):
                raise ValueError(f"member @{name} already exists")
            names = {m["name"] for m in _active_members(sw)}
            clash = [g for g in groups if g in names] + ([name] if name in _groups(sw) else [])
            if clash:
                raise ValueError(f"name/group clash: {', '.join(clash)}")
        workspace = (sessions.get(coord, light=True) or {}).get("workspace") or None
        tree = None
        if body.get("worktree"):
            if not workspace:
                raise ValueError("worktree needs the coordinator session to have a workspace")
            key = f"{coord[:8]}-{name}-{uuid.uuid4().hex[:4]}"
            tree = _add_worktree(workspace, store.path.parent / "swarm-worktrees", key,
                                 f"swarm/{key}")
        try:
            child = sessions.create(parent_id=coord, title=f"@{name} \u00b7 {role_title}"[:120],
                                    workspace=tree[0] if tree else workspace)
        except Exception:
            if tree:
                try:
                    _git(tree[2], "worktree", "remove", "--force", tree[4], timeout=120)
                    _git(tree[2], "branch", "-D", tree[1])
                except Exception:
                    log.warning("swarm: could not clean up worktree %s", tree[0], exc_info=True)
            raise
        member = {"name": name, "role": role_title, "brief": brief, "groups": groups,
                  "session": child["id"], "created": time.time(), "status": "idle", "runs": 0,
                  "cursor": 0, "pending": 0}
        if tree:
            member.update(worktree=tree[4], workdir=tree[0], branch=tree[1], repo=tree[2], base=tree[3])
        values = {}
        if model:
            values.update(model)
        if effort:
            values["effort"] = effort
        if values:
            sessions.remember_for(child["id"], **values)
            member.update(values)
        with lock:
            sw["members"][name] = member
            _add_post(sw, "system", f"@{name} joined as {role_title}"
                      + (f" (groups: {', '.join('@' + g for g in groups)})" if groups else ""), kind="system")
        _publish()
        return {"member": _public_member(member)}

    def remove(body, call=None):
        sw, _ = _swarm_of(_sid(body), coordinator=True)
        return _remove(sw, _text(body, "name", limit=32).lower().lstrip("@"))

    def _remove(sw, name):
        with lock:
            m = sw["members"].get(name)
            if m is None or m.get("removed"):
                raise ValueError(f"no member @{name}")
            run_id = m.get("run_id") if m.get("status") == "running" else None
            m.update(removed=True, pending=0)
            _add_post(sw, "system", f"@{name} left the swarm", kind="system")
        if run_id:
            try:
                runs.cancel(run_id)
            except Exception as error:
                log.warning("swarm: cancel %s failed: %s", run_id, error)
        _publish()
        return {"removed": name, "cancelling": bool(run_id)}

    def set_model(body, call=None):
        sw, _ = _swarm_of(_sid(body), coordinator=True)
        return _set_model(sw, _text(body, "name", limit=32).lower().lstrip("@"), body)

    def _set_model(sw, name, body):
        values = _settings(body)
        with lock:
            m = sw["members"].get(name)
            if m is None or m.get("removed"):
                raise ValueError(f"no member @{name}")
            try:
                sessions.remember_for(m["session"], **values)
                deferred = False
            except RuntimeError:
                # Running: a session's settings are fixed for its turn; apply before the next one.
                m["pending_settings"] = {**(m.get("pending_settings") or {}), **values}
                deferred = True
            else:
                m.pop("pending_settings", None)
                _sync(m)
            label = values.get("model") if "model" in values else None
            what = ", ".join(x for x in (
                ("model " + (label or "default")) if "model" in values else "",
                ("effort " + (values["effort"] or "default")) if "effort" in values else "") if x)
            _add_post(sw, "system", f"@{name} now uses {what}"
                      + (" (from the next turn)" if deferred else ""), kind="system")
        _publish()
        return {"member": _public_member(m), "deferred": deferred}

    def models(body, call=None):
        rows = _catalog()
        if rows is None:
            raise RuntimeError("model selection is unavailable (no model catalog)")
        return {"models": [{"key": r.get("key"), "name": r["name"], "model": r.get("model")} for r in rows]}

    def finish(body, call=None):
        sw, _ = _swarm_of(_sid(body), coordinator=True)
        summary = _text(body, "summary", limit=4000)
        with lock:
            _add_post(sw, COORD, summary, kind="finish")
            sw["finished"] = time.time()
            for p in _all_parts(sw):
                p["pending"] = 0
        _publish()
        return {"finished": True}

    OPS = {"role": role, "post": post, "read": read, "wait": wait, "members": members,
           "add": add, "remove": remove, "models": models, "set_model": set_model,
           "finish": finish}

    def rpc(body, call=None):
        body = body if isinstance(body, dict) else {}
        op = OPS.get(body.get("op"))
        if op is None:
            raise ValueError("unknown swarm operation")
        if call is not None and getattr(call, "session_id", None):
            body["session_id"] = call.session_id  # a worker speaks only for its own session
        return op(body, call)

    # ---- web routes ------------------------------------------------------
    def toggle(body):
        sid = _sid(body)
        on = bool(body.get("enabled"))
        with lock:
            sw = swarms.get(sid)
            if on:
                other, name = _locate(sid)
                if other is not None and name != COORD:
                    raise RuntimeError("a member session cannot start its own swarm")
                if sw is None:
                    sw = swarms[sid] = {"id": sid, "created": time.time(), "enabled": True,
                                        "coordinator": {"name": COORD, "session": sid, "status": "idle",
                                                        "cursor": 0, "pending": 0, "runs": 0},
                                        "members": {}, "posts": [], "seq": 0, "wakes": 0}
                else:
                    sw["enabled"] = True
                    sw.pop("finished", None)
                    sw.pop("paused", None)
                    sw["wakes"] = 0
            elif sw is not None:
                sw["enabled"] = False
                for p in _all_parts(sw):
                    p["pending"] = 0
        _publish()
        return {"enabled": on}

    def user_post(body):
        sid = _sid(body)
        with lock:
            sw, _ = _locate(sid)
            if sw is None:
                raise RuntimeError("this session is not part of an active swarm")
            if sw.get("finished"):
                raise RuntimeError("the swarm is finished; turn swarm mode on again to resume")
            item = _add_post(sw, "user", _text(body, "text"))
            _deliver(sw, item)
        _publish()
        _pump()
        return {"post": item}

    def web_remove(body):
        sw, _ = _swarm_of(_sid(body))
        return _remove(sw, _text(body, "name", limit=32).lower())

    def web_model(body):
        sw, _ = _swarm_of(_sid(body))
        return _set_model(sw, _text(body, "name", limit=32).lower().lstrip("@"), body)

    def web_models(body):
        rows = _catalog()
        return {"models": [] if rows is None else
                [{"key": r.get("key"), "name": r["name"], "model": r.get("model")} for r in rows],
                "available": rows is not None}

    def web_cancel(body):
        sw, _ = _swarm_of(_sid(body))
        name = _text(body, "name", limit=32).lower()
        with lock:
            p = _part(sw, name)
            if p is None:
                raise ValueError(f"no participant @{name}")
            run_id = p.get("run_id") if p.get("status") == "running" else None
            p["pending"] = 0
        if run_id:
            runs.cancel(run_id)
        return {"cancelling": bool(run_id)}

    def resume(body):
        sw, _ = _swarm_of(_sid(body))
        with lock:
            sw.pop("paused", None)
            sw["wakes"] = 0
        _publish()
        _pump()
        return {"resumed": True}

    def board(body):
        sw, _ = _swarm_of(_sid(body))
        before = body.get("before") if isinstance(body.get("before"), int) else None
        with lock:
            items = [x for x in sw["posts"] if before is None or x["id"] < before][-SNAPSHOT_POSTS:]
        return {"posts": items}

    def _route(fn):
        def route(request):
            body = request.get("body") or {}
            try:
                result = fn(body)
            except ValueError as error:
                return 400, {"error": str(error)}
            except RuntimeError as error:
                return 409, {"error": str(error)}
            return 200, {"ok": True, **(result or {})}
        return route

    # ---- hooks -----------------------------------------------------------
    def on_finished(data, nxt=None):
        try:
            sid, run_id = data.get("session_id"), data.get("run_id")
            record = data.get("run") or {}
            hit = False
            with lock:
                for sw in swarms.values():
                    for p in _all_parts(sw):
                        if p["session"] == sid and p.get("run_id") == run_id and p.get("status") == "running":
                            p.update(status="idle", run_id=None, finished=time.time(),
                                     last_status=record.get("status") or "done",
                                     error=(record.get("error") or "")[:300])
                            if p.get("pending_settings"):
                                _apply_pending(p)  # may still be active; _start retries
                            else:
                                _sync(p)
                            sw["last_activity"] = time.time()
                            hit = True
                    # Any finished run (also a private user turn) may unblock queued wake-ups.
                    if any(p["session"] == sid for p in _all_parts(sw)):
                        hit = True
            if hit:
                _publish()
                threading.Thread(target=_pump, daemon=True, name="swarm-pump").start()
        except Exception as error:
            log.warning("swarm: run.finished handling failed: %s", error)
        return nxt(data) if nxt else None

    def _edges(sw):
        counts = {}
        for x in sw["posts"]:
            if x.get("kind") != "post":
                continue
            for t in x["mentions"]:
                key = (x["author"], t)
                counts[key] = counts.get(key, 0) + 1
        return [{"from": a, "to": b, "count": n} for (a, b), n in counts.items()]

    def snapshot(data, nxt=None):
        try:
            current = data.get("session_id")
            with lock:
                sw, me = _locate(current) if current else (None, None)
                view = None
                if sw is None and current in swarms:
                    sw, me = swarms[current], COORD  # disabled: still show its history
                if sw is not None:
                    view = {"id": sw["id"], "me": me, "enabled": bool(sw.get("enabled")),
                            "finished": sw.get("finished"), "paused": sw.get("paused"),
                            "coordinator": _public_member(sw["coordinator"], brief=True),
                            "members": [_public_member(m) for m in sw["members"].values()],
                            "groups": _groups(sw), "posts": sw["posts"][-SNAPSHOT_POSTS:],
                            "total_posts": sw.get("seq", 0), "edges": _edges(sw),
                            "wakes": sw.get("wakes", 0)}
                data["swarm"] = {"enabled": sorted(k for k, v in swarms.items() if v.get("enabled")),
                                 "members": {m["session"]: {"swarm": s["id"], "name": m["name"]}
                                             for s in swarms.values() for m in s["members"].values()
                                             if not m.get("removed")},
                                 "current": current, "view": view, "limits": dict(settings),
                                 "running": _running_total(),
                                 "persistence_error": store.persistence_error}
        except Exception as error:
            log.warning("swarm: snapshot failed: %s", error)
        return nxt(data) if nxt else data

    store.save()
    ctx.scope.add(runs.register_rpc("swarm", rpc))
    ctx.scope.add(runs.register_worker_plugin("swarm-worker"))
    ctx.on("web.snapshot", snapshot)
    ctx.on("run.finished", on_finished)

    def is_enabled(sid):
        with lock:
            return bool((swarms.get(sid) or {}).get("enabled"))

    ctx.provide("swarm.mode", SimpleNamespace(
        enabled=is_enabled, toggle=lambda sid, on: toggle({"session_id": sid, "enabled": bool(on)})["enabled"]))
    script, style = HERE / "client.js", HERE / "client.css"
    ctx.scope.add(host.register("swarm", script=script if script.is_file() else None,
                                style=style if style.is_file() else None, order=37,
                                routes={("POST", "toggle"): _route(toggle),
                                        ("POST", "post"): _route(user_post),
                                        ("POST", "remove"): _route(web_remove),
                                        ("POST", "model"): _route(web_model),
                                        ("POST", "models"): _route(web_models),
                                        ("POST", "cancel"): _route(web_cancel),
                                        ("POST", "resume"): _route(resume),
                                        ("POST", "board"): _route(board)}))
    monitor = threading.Thread(target=_monitor, daemon=True, name="swarm-monitor")
    monitor.start()

    def close():
        stop.set()
        with lock:
            changed.notify_all()
            store.save()
    ctx.scope.add(close)


def _all_parts(sw):
    return [sw["coordinator"]] + list(sw["members"].values())
