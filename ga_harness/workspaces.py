"""Workspace/project state, independent of any frontend or GA imports.

Workspace is an execution base, NOT a security sandbox. Changing scope starts or
selects another conversation; it never relabels an existing conversation's history.
"""
from __future__ import annotations

import copy
from pathlib import Path
import re
import threading
import time
import uuid


class Workspaces:
    def __init__(self, sessions, default_workspace):
        self.sessions = sessions
        self.default_workspace = self.directory(str(Path(default_workspace).expanduser().resolve()))
        self.active = None
        with sessions.lock:
            sessions.current()
            with sessions._db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace TEXT NOT NULL,
                    rules TEXT NOT NULL, memory TEXT NOT NULL, updated REAL NOT NULL)""")
                db.execute("UPDATE sessions SET workspace=? WHERE workspace=''",
                           (self.default_workspace,))

    @staticmethod
    def directory(value):
        if not isinstance(value, str) or not value.strip():
            raise ValueError("workspace must be an existing absolute directory")
        path = Path(value.strip()).expanduser()
        if not path.is_absolute() or not path.is_dir():
            raise ValueError("workspace must be an existing absolute directory on the server")
        return str(path.resolve())

    @staticmethod
    def text(value, label, limit, required=False):
        if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
            raise ValueError(f"{label} must contain {'1' if required else '0'}-{limit} characters")
        return value.strip() if required else value

    def projects(self):
        with self.sessions.lock, self.sessions._db() as db:
            return [dict(r) for r in db.execute("SELECT * FROM projects ORDER BY updated DESC, id")]

    def current(self):
        with self.sessions.lock:
            current = self.sessions.current()
            project = next((p for p in self.projects() if p["id"] == current["project_id"]), None)
            if current["project_id"] and project is None:
                raise ValueError("project no longer exists")
            return {"workspace": current["workspace"] or self.default_workspace,
                    "project_id": current["project_id"], "project": project}

    def snapshot(self):
        with self.sessions.lock:
            return {**self.current(), "projects": self.projects(), "default_workspace": self.default_workspace}

    def change(self, body):
        """Must be called while idle; web callers also hold the frontend lock."""
        store = self.sessions
        with store.lock:
            store._idle()
            action = body.get("action")
            if action in ("create", "update"):
                name = self.text(body.get("name"), "name", 120, True)
                rules = self.text(body.get("rules", ""), "rules", 16000)
                memory = self.text(body.get("memory", ""), "memory", 16000)
                pid = body.get("id") if action == "update" else uuid.uuid4().hex
                workspace = self.directory(body.get("workspace")) if action == "create" else None
                with store._db() as db:
                    if action == "create":
                        db.execute("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)",
                                   (pid, name, workspace, rules, memory, time.time()))
                        sid = store._new(db, workspace, pid)
                        store._select(db, sid)
                    else:
                        old = db.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
                        if old is None:
                            raise ValueError("project not found")
                        if body.get("updated") != old["updated"]:
                            raise RuntimeError("project changed in another tab; reopen before saving")
                        db.execute("UPDATE projects SET name=?, rules=?, memory=?, updated=? WHERE id=?",
                                   (name, rules, memory, time.time(), pid))
                if action == "create":
                    from .sessions import restore
                    restore(store.agent, {})
            elif action == "workspace":
                directory = self.directory(body.get("workspace"))
                store.change("new", workspace=directory, project_id="")
            elif action == "select":
                pid = body.get("id", "")
                if not isinstance(pid, str):
                    raise ValueError("invalid project id")
                project = next((p for p in self.projects() if p["id"] == pid), None)
                if pid and project is None:
                    raise ValueError("project not found")
                target = next((s for s in store.listing() if s["project_id"] == pid), None)
                if target:
                    store.change("select", target["id"])
                else:
                    store.change("new", workspace=project["workspace"] if project else self.default_workspace,
                                 project_id=pid)
            else:
                raise ValueError("unknown workspace action")
            return store.current()

    def request(self, request, nxt):
        """Reserve selection BEFORE queueing; keep it reserved until GA really stops.

        A timeout may return before GA finishes aborting. In that case the release
        thread drains its queue before allowing another scope or request.
        """
        store = self.sessions
        with store.lock:
            store._idle()
            context = self.current()
            context["workspace"] = self.directory(context["workspace"])
            self.active = context
            store.reserved = True
        try:
            return nxt(request)
        finally:
            def release():
                q = getattr(store.agent, "task_queue", None)
                if q is not None:
                    q.join()
                with store.lock:
                    if self.active is context:
                        self.active = None
                        store.reserved = False
                        store.save(store.current()["messages"])
            q = getattr(store.agent, "task_queue", None)
            if getattr(q, "unfinished_tasks", 0):
                threading.Thread(target=release, name="workspace-drain", daemon=True).start()
            else:
                release()

    def bind(self, g, nxt):
        """GA's existing agent_before hook receives the actual mutable handler."""
        handler = g.get("handler")
        if handler is not None and getattr(handler, "parent", None) is self.sessions.agent:
            if self.active is None:
                raise RuntimeError("no reserved workspace for this request")
            handler.cwd = self.active["workspace"]
        return nxt(g)

    def inject(self, g, nxt):
        """Reassert the pinned scope at every LLM call, without modifying user text.

        GA replaces messages after each tool turn. A fresh system block also lets
        providers that keep their own history update the system context reliably.
        """
        handler = g.get("handler")
        if handler is not None and getattr(handler, "parent", None) is self.sessions.agent and self.active:
            context = self.active
            project = context["project"]
            text = ("[Harness execution context]\n"
                    f"Actual tool working directory (cwd): {context['workspace']}\n"
                    "This overrides any default cwd above. Relative tool paths resolve here. "
                    "This directory is not a security sandbox.\n")
            if project:
                text += (f"Project: {project['name']} (id: {project['id']})\n"
                         "Only this project's shared context applies to this conversation.\n"
                         f"[Project rules]\n{project['rules']}\n"
                         f"[Shared project notes]\n{project['memory']}\n"
                         "Shared notes are user-managed in project settings; do not claim to save them via working memory.\n")
            else:
                text += "No project is selected. Do not inherit other projects' rules or notes.\n"
            messages = g.get("messages", [])
            system = next((m for m in messages if m.get("role") == "system"), None)
            if system is None:
                messages.insert(0, {"role": "system", "content": text})
            elif isinstance(system.get("content"), str):
                original = re.split(r"(?:^|\n)\[Harness execution context\]", system["content"], maxsplit=1)[0]
                original = re.sub(r"(?m)^cwd = .*?$", "cwd = " + context["workspace"].replace("\\", "\\\\") + " (./)", original)
                system["content"] = original + "\n" + text
        return nxt(g)
