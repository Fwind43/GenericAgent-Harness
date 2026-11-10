"""Bounded, stoppable reflect sources owned by a conductor session.

All script code runs in a persistent child Python, never in the host. Metadata
is in conductor.json; inline scripts and temporary IPC live beside that file.
After a restart sources are explicitly interrupted, not silently replayed.
"""
from __future__ import annotations

from contextlib import ExitStack
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import uuid

TERMINAL = {"stopped", "done", "error", "interrupted"}
SOURCE = "conductor-reflect"
PER_SESSION, GLOBAL_LIMIT, HISTORY = 4, 16, 48


class Reflections:
    def __init__(self, records, directory, lock, publish, wake):
        self.records, self.directory, self.lock = records, Path(directory), lock
        self.publish, self.wake = publish, wake
        self.workers = {}
        self.closed = False
        for item in records.values():
            if item.get("status") not in TERMINAL:
                item.update(status="interrupted", error="Host/plugin restarted; script state was lost. "
                            "Register again explicitly; the last event may already have run.",
                            finished=time.time())
                item.pop("message", None)

    def public(self, item):
        return {k: v for k, v in item.items() if k not in {"message", "result", "args"}}

    def listing(self, parent):
        with self.lock:
            return [self.public(r) for r in self.records.values() if r["parent"] == parent]

    def operation(self, body):
        parent, action = body["session_id"], body.get("action", "list")
        if action == "list":
            return {"reflections": self.listing(parent)}
        if action == "stop":
            with self.lock:
                item = self.records.get(body.get("reflect_id"))
                if not item or item["parent"] != parent:
                    raise ValueError("unknown reflect_id for this session")
                self._end(item, "stopped")
            self.publish()
            return self.public(item)
        if action != "start":
            raise ValueError("action must be start, list or stop")
        code, path = body.get("code"), body.get("path")
        if bool(code) == bool(path):
            raise ValueError("provide exactly one of code or absolute path")
        if code and (not isinstance(code, str) or len(code) > 40000):
            raise ValueError("code must be a string of at most 40000 characters")
        if path:
            if not isinstance(path, str):
                raise ValueError("path must be an absolute Python script path")
            path = Path(path).expanduser()
            if not path.is_absolute() or not path.is_file() or path.suffix.lower() != ".py":
                raise ValueError("path must be an existing absolute .py path on the host")
            path = path.resolve()
        args = body.get("args", [])
        if (not isinstance(args, list) or len(args) > 64
                or any(not isinstance(a, str) or len(a) > 2000 for a in args)):
            raise ValueError("args must be at most 64 strings of at most 2000 characters")
        timeout, lifetime = body.get("timeout", 30), body.get("lifetime", 86400)
        if (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
                or not math.isfinite(timeout) or not 1 <= timeout <= 300):
            raise ValueError("timeout must be between 1 and 300 seconds")
        if lifetime in (0, "forever", "permanent"):
            expires = None
        elif (isinstance(lifetime, bool) or not isinstance(lifetime, (int, float))
              or not math.isfinite(lifetime) or not 1 <= lifetime <= 604800):
            raise ValueError("lifetime must be between 1 and 604800 seconds, or 0 for permanent")
        else:
            expires = time.time() + lifetime
        title = body.get("title") or (path.stem if path else "Reflect")
        if not isinstance(title, str) or len(title) > 120:
            raise ValueError("title must be a string of at most 120 characters")
        raw_inst = body.get("instruction")
        if raw_inst is not None and (not isinstance(raw_inst, str) or len(raw_inst) > 4000):
            raise ValueError("instruction must be a string of at most 4000 characters")
        instruction = (raw_inst or "").strip()
        with self.lock:
            if self.closed:
                raise RuntimeError("conductor is stopping")
            live = [r for r in self.records.values() if r["status"] not in TERMINAL]
            owned = [self.records[rid] for rid in self.workers]
            if len(owned) >= GLOBAL_LIMIT or sum(r["parent"] == parent for r in owned) >= PER_SESSION:
                raise RuntimeError("reflect limit reached (4 per session, 16 globally)")
            if path and any(r["parent"] == parent and r["path"] == str(path) for r in live):
                raise ValueError("this script is already registered for this session")
            own = sorted((r for r in self.records.values() if r["parent"] == parent),
                         key=lambda r: r["created"])
            while len(own) >= HISTORY:
                old = next(r for r in own if r["status"] in TERMINAL and r["id"] not in self.workers)
                self.records.pop(old["id"])
                own.remove(old)
            rid = "ref-" + uuid.uuid4().hex[:12]
            self.directory.mkdir(parents=True, exist_ok=True)
            if code:
                path = self.directory / (rid + ".py")
                path.write_text(code, encoding="utf-8")
            item = dict(id=rid, parent=parent, title=title, path=str(path), args=args,
                        timeout=timeout, created=time.time(), expires=expires,
                        status="starting", interval=5, once=False, triggers=0,
                        **(dict(instruction=instruction) if instruction else {}))
            self.records[rid] = item
            control = {"stop": threading.Event(), "proc": None, "early": {}}
            self.workers[rid] = control
            thread = threading.Thread(target=self._loop, args=(item, control),
                                      name="conductor-" + rid, daemon=True)
            control["thread"] = thread
            thread.start()
        self.publish()
        return self.public(item)

    def _end(self, item, status, error=""):
        # Caller holds the shared conductor lock. Never wait for a process here.
        if item["status"] in TERMINAL:
            return
        item.update(status=status, error=error[:4000], finished=time.time())
        item.pop("message", None)
        item.pop("result", None)
        control = self.workers.get(item["id"])
        if control:
            control["stop"].set()

    def stop_parent(self, parent):
        with self.lock:
            for item in self.records.values():
                if item["parent"] == parent:
                    self._end(item, "stopped", "Conductor mode turned off")

    def ready(self, parent):
        # Caller holds lock; one event per run, so on_done receives its own result.
        return next((r for r in self.records.values() if r["parent"] == parent
                     and r["status"] == "pending" and r.get("retry_at", 0) <= time.time()), None)

    def claim(self, item):
        item["status"] = "submitting"
        msg = item["message"]
        parts = [msg] if msg.startswith("[Conductor event") else [f"[Conductor event \u00b7 {item['title']} ({item['id']})]", msg]
        if item.get("instruction"):
            parts.append(f"Action: {item['instruction']}")
        return "\n".join(parts)

    def submitted(self, item, run_id):
        if item["status"] != "submitting":
            return
        item.update(status="waiting", run_id=run_id, triggers=item["triggers"] + 1,
                    result_deadline=time.time() + 3600, retries=0)
        item.pop("message", None)
        early = self.workers[item["id"]]["early"].pop(run_id, None)
        if early is not None:
            item.update(status="callback", result=early)

    def failed(self, item, error, retries, delay):
        if item["status"] != "submitting":
            return
        count = item.get("retries", 0) + 1
        if count > retries:
            self._end(item, "error", "Wake submission failed: " + str(error))
        else:
            item.update(status="pending", retries=count, retry_at=time.time() + delay)

    def finished(self, parent, run_id, record, result):
        if record.get("source") != SOURCE:
            return
        result = result[:20000]
        if record.get("status") != "done":
            result = f"[ERROR] {record.get('status')}: {record.get('error') or ''}\n" + result
        with self.lock:
            for item in self.records.values():
                if item["parent"] != parent:
                    continue
                if item["status"] == "waiting" and item.get("run_id") == run_id:
                    item.update(status="callback", result=result)
                elif item["status"] == "submitting":
                    # A very fast run may finish before frontend.submit returns its id.
                    self.workers[item["id"]]["early"][run_id] = result

    def _loop(self, item, control):
        stop, proc = control["stop"], None
        seq = 0
        try:
            with ExitStack() as cleanup:
                tmp = cleanup.enter_context(tempfile.TemporaryDirectory(
                    prefix=item["id"] + "-", dir=self.directory))
                directory = Path(tmp)
                if stop.is_set():
                    return
                proc = subprocess.Popen(
                    [sys.executable, "-u", str(Path(__file__).with_name("reflect_runner.py")),
                     str(directory), item["path"]], stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                cleanup.callback(self._terminate, proc)
                with self.lock:
                    control["proc"] = proc

                def request(op, **body):
                    nonlocal seq
                    if stop.is_set():
                        raise InterruptedError("reflect stopped")
                    seq += 1
                    staged = directory / "request.tmp"
                    staged.write_text(json.dumps(dict(seq=seq, op=op, **body)), encoding="utf-8")
                    os.replace(staged, directory / "request.json")
                    deadline = time.time() + item["timeout"]
                    if item.get("expires") is not None:
                        deadline = min(deadline, item["expires"])
                    while not stop.is_set():
                        response = directory / "response.json"
                        if response.exists():
                            if response.stat().st_size > 200000:
                                raise RuntimeError("oversized reflect response")
                            reply = json.loads(response.read_text(encoding="utf-8"))
                            if reply.get("seq") == seq:
                                if reply.get("error"):
                                    raise RuntimeError(reply["error"])
                                return reply
                        if proc.poll() is not None:
                            raise RuntimeError(f"reflect process exited ({proc.returncode})")
                        if time.time() >= deadline:
                            raise TimeoutError(f"reflect {op} timed out")
                        stop.wait(0.1)
                    raise InterruptedError("reflect stopped")

                reply = request("init", args=item["args"])
                with self.lock:
                    if not stop.is_set():
                        item.update(status="sleeping", interval=reply["interval"], once=reply["once"],
                                    next_check=time.time())
                self.publish()
                while not stop.is_set():
                    with self.lock:
                        status = item["status"]
                        now = time.time()
                        if item.get("expires") is not None and now >= item["expires"]:
                            raise TimeoutError("reflect lifetime expired")
                        if status == "waiting" and now >= item["result_deadline"]:
                            raise TimeoutError("reflect run result not received within one hour")
                        due = status == "sleeping" and now >= item["next_check"]
                        result = item.get("result", "")
                    if proc.poll() is not None:
                        raise RuntimeError(f"reflect process exited ({proc.returncode})")
                    if due or status == "callback":
                        reply = request("check") if due else request("done", result=result)
                        with self.lock:
                            if stop.is_set():
                                break
                            item.update(interval=reply["interval"], once=reply["once"])
                            item.pop("result", None)
                            value = reply.get("value")
                            if due and value == "/exit" or status == "callback" and item["once"]:
                                self._end(item, "done")
                            elif due and value:
                                item.update(status="pending", message=value, triggered=time.time(), retries=0)
                            else:
                                item.update(status="sleeping", next_check=time.time() + item["interval"])
                        self.publish()
                    with self.lock:
                        ready = item["status"] == "pending" and item.get("retry_at", 0) <= time.time()
                    if ready:
                        self.wake(item["parent"])
                    stop.wait(0.5)
        except Exception as error:
            with self.lock:
                self._end(item, "error", str(error))
            self.publish()
        finally:
            with self.lock:
                self.workers.pop(item["id"], None)

    @staticmethod
    def _terminate(proc):
        # ExitStack calls this BEFORE removing IPC files (notably on Windows).
        if proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                if proc.poll() is None:
                    raise
        proc.wait(timeout=5)

    def close(self):
        with self.lock:
            self.closed = True
            controls = list(self.workers.values())
            for item in self.records.values():
                self._end(item, "interrupted", "Conductor plugin stopped; register again explicitly")
        # Only our script PIDs are stopped. Never touch a harness or model worker.
        for control in controls:
            proc = control["proc"]
            if proc is not None and proc.poll() is None:
                try:
                    proc.kill()
                except OSError:
                    pass
        for control in controls:
            control["thread"].join(timeout=2)
        self.publish()
