"""Workspace/project state, independent of any frontend or GA imports.

Workspace is an execution base, NOT a security sandbox. Changing scope starts or
selects another conversation; it never relabels an existing conversation's history.
"""
from __future__ import annotations

import copy
import json
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

    @staticmethod
    def project_name(value):
        """Project names double as GA project_mode directories under temp/projects."""
        name = Workspaces.text(value, "name", 120, True)
        if re.search(r'[\\/:*?"<>|\x00-\x1f]', name) or name in (".", "..") or name.endswith("."):
            raise ValueError('name must be a valid folder name (no \\ / : * ? " < > |)')
        return name

    @staticmethod
    def ga_project(agent, context):
        """Activate GA's official plugins/project_mode for this request (None = off)."""
        project = (context or {}).get("project")
        if agent is not None:
            agent._ga_project_mode_name = project["name"] if project else None

    def projects(self):
        with self.sessions.lock, self.sessions._db() as db:
            return [{k: r[k] for k in ("id", "name", "workspace", "updated")}
                    for r in db.execute("SELECT * FROM projects ORDER BY updated DESC, id")]

    def current(self):
        return self.context(self.sessions.current()["id"])

    def context(self, session_id):
        """Resolve a pinned session, independently of the UI's selection."""
        with self.sessions.lock:
            current = self.sessions.get(session_id)
            project = next((p for p in self.projects() if p["id"] == current["project_id"]), None)
            if current["project_id"] and project is None:
                raise ValueError("project no longer exists")
            return {"workspace": self.directory(current["workspace"] or self.default_workspace),
                    "project_id": current["project_id"], "project": project}

    def snapshot(self):
        with self.sessions.lock:
            return {**self.current(), "projects": self.projects(), "default_workspace": self.default_workspace}

    def _enter(self, db, workspace, project_id):
        """Bind the current conversation if it has no history, else open a new one."""
        store = self.sessions
        row = db.execute("SELECT s.id, s.messages, s.workspace, s.project_id FROM sessions s "
                         "JOIN meta m ON m.key='current' AND m.value=s.id WHERE s.deleted=0").fetchone()
        if row is not None and json.loads(row["messages"]) == []:
            db.execute("UPDATE sessions SET workspace=?, project_id=?, updated=? WHERE id=?",
                       (workspace, project_id, time.time(), row["id"]))
            return row["id"]
        sid = store._new(db, workspace, project_id)
        store._select(db, sid)
        return sid

    def change(self, body):
        """Must be called while idle; web callers also hold the frontend lock."""
        store = self.sessions
        with store.lock:
            store._idle()
            action = body.get("action")
            if action in ("create", "update"):
                # Rules/notes columns are kept for old databases but no longer used:
                # project memory lives in GA's temp/projects/<name>/project_memory.md.
                # A project is a durable identity (name -> memory directory); its workspace
                # is only the default directory for new chats. Blank = current workspace.
                name = self.project_name(body.get("name"))
                pid = body.get("id") if action == "update" else uuid.uuid4().hex
                given = body.get("workspace")
                workspace = self.directory(given) if isinstance(given, str) and given.strip() else None
                with store._db() as db:
                    if action == "create":
                        workspace = workspace or self.current()["workspace"]
                        db.execute("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)",
                                   (pid, name, workspace, "", "", time.time()))
                        self._enter(db, workspace, pid)
                    else:
                        old = db.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
                        if old is None:
                            raise ValueError("project not found")
                        if body.get("updated") != old["updated"]:
                            raise RuntimeError("project changed in another tab; reopen before saving")
                        # Existing chats keep their own workspace; only new chats use the new default.
                        db.execute("UPDATE projects SET name=?, workspace=?, updated=? WHERE id=?",
                                   (name, workspace or old["workspace"], time.time(), pid))
                if action == "create":
                    from .sessions import restore
                    restore(store.agent, {})
            elif action == "workspace":
                directory = self.directory(body.get("workspace"))
                store.change("new", workspace=directory, project_id="")
            elif action == "enter":
                # Conversation-level scope: an empty conversation is rebound in place;
                # one with history stays untouched and a new conversation is opened.
                pid = body.get("id", "")
                if not isinstance(pid, str):
                    raise ValueError("invalid project id")
                if pid:
                    project = next((p for p in self.projects() if p["id"] == pid), None)
                    if project is None:
                        raise ValueError("project not found")
                    directory = self.directory(project["workspace"])
                elif body.get("workspace"):
                    directory = self.directory(body.get("workspace"))
                else:
                    directory = self.default_workspace
                with store._db() as db:
                    self._enter(db, directory, pid)
                from .sessions import restore
                if not store.current()["messages"]:
                    restore(store.agent, {})
            elif action == "delete":
                # Unlink chats (they move to the no-project list); memory files are kept.
                pid = body.get("id")
                with store._db() as db:
                    if db.execute("SELECT 1 FROM projects WHERE id=?", (pid,)).fetchone() is None:
                        raise ValueError("project not found")
                    db.execute("UPDATE sessions SET project_id='' WHERE project_id=?", (pid,))
                    db.execute("DELETE FROM projects WHERE id=?", (pid,))
            elif action == "move":
                # Re-file one chat under another project (or none); its workspace and
                # history stay, only future turns use the new project's memory.
                sid, pid = body.get("session_id"), body.get("project_id", "")
                if not isinstance(sid, str) or not isinstance(pid, str):
                    raise ValueError("invalid session or project id")
                if pid and not any(p["id"] == pid for p in self.projects()):
                    raise ValueError("project not found")
                if sid in getattr(store, "active", ()):
                    raise RuntimeError("wait for this chat's run to finish")
                with store._db() as db:
                    if db.execute("UPDATE sessions SET project_id=? WHERE id=? AND deleted=0",
                                  (pid, sid)).rowcount != 1:
                        raise ValueError("session not found")
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
            self.ga_project(store.agent, context)
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
            Workspaces.ga_project(handler.parent, self.active)
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
            if not project:
                text += "No project is selected. Do not use any project's memory.\n"
            messages = g.get("messages", [])
            system = next((m for m in messages if m.get("role") == "system"), None)
            if system is None:
                messages.insert(0, {"role": "system", "content": text})
            elif isinstance(system.get("content"), str):
                original = re.split(r"(?:^|\n)\[Harness execution context\]", system["content"], maxsplit=1)[0]
                original = re.sub(r"(?m)^cwd = .*?$", "cwd = " + context["workspace"].replace("\\", "\\\\") + " (./)", original)
                system["content"] = original + "\n" + text
        return nxt(g)
