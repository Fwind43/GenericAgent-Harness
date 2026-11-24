import importlib.util
import textwrap
import uuid
from types import SimpleNamespace

from ga_harness.kernel import Runtime
from ga_harness.kernel.loader import discover, mount
from pathlib import Path

PLUGINS = Path(__file__).resolve().parents[1] / "ga_harness" / "plugins"

FAKE = textwrap.dedent('''
    import queue
    class GenericAgent:
        def __init__(self):
            self.llmclients = ["fake"]; self.inc_out = False
            self.task_queue = queue.Queue(); self.aborted = 0; self.exited = False
        def put_task(self, query, source="user", images=None):
            dq = queue.Queue(); self.task_queue.put({"query": query, "output": dq}); return dq
        def abort(self): self.aborted += 1
        def run(self):
            while True:
                t = self.task_queue.get()
                if isinstance(t, str): self.exited = True; break
                q = t["query"]; acc = ""
                for ch in q:
                    acc += ch; t["output"].put({"next": acc if not self.inc_out else ch})
                t["output"].put({"done": "echo:" + q})
                self.task_queue.task_done()
''')


def _mount(tmp_path, inc_out):
    mod = "fake_agentmain_" + uuid.uuid4().hex[:8]
    (tmp_path / f"{mod}.py").write_text(FAKE, encoding="utf-8")
    rt = Runtime()
    mount(rt, [{"name": "ga-core", "disabled": False,
                "config": {"ga_root": str(tmp_path), "module": mod, "inc_out": inc_out}}], discover([PLUGINS]))
    return rt


def test_run_streams_and_returns(tmp_path):
    for inc in (True, False):
        rt = _mount(tmp_path, inc)
        assert rt.handles["ga-core"].state == "active"
        chunks, done = [], []
        rt.ctx.events.on("agent.chunk", chunks.append)
        rt.ctx.events.on("agent.done", lambda text, item: done.append(text))
        assert rt.ctx.get("agent").run("abc", timeout=5) == "echo:abc"
        assert "".join(chunks) == "abc" and done == ["echo:abc"]
        raw = rt.ctx.get("ga.agent")
        rt.dispose()
        assert raw.exited and raw.aborted == 1
        assert rt.ctx.get("agent") is None


def test_update_slash_cmd_expands_official_prompt(tmp_path):
    pkg = tmp_path / "frontends"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "slash_cmds.py").write_text(textwrap.dedent('''
        def prompt_for(cmd, args_text=""):
            if cmd == "update":
                base = "[SYSTEM COMMAND: SELF-UPDATE]"
                return f"{base}\\n\\nUser notes: {args_text}" if args_text else base
            return None
    '''), encoding="utf-8")
    (tmp_path / ".gah-ga-ref").write_text("e4d956f0207a2d268704634473196353946481bc\n", encoding="utf-8")
    rt = _mount(tmp_path, True)
    try:
        out = rt.ctx.get("agent").run("/update keep local prompt tweaks", timeout=5)
        assert out.startswith("echo:[SYSTEM COMMAND: SELF-UPDATE]")
        assert "User notes: keep local prompt tweaks" in out
        assert str(tmp_path.resolve()) in out
        assert "e4d956f0207a2d268704634473196353946481bc" in out
        assert "git reset --mixed e4d956f0207a2d268704634473196353946481bc" in out
    finally:
        rt.dispose()

GA_CORE_MAIN = Path(__file__).resolve().parents[1] / "ga_harness" / "plugins" / "ga-core" / "main.py"


def _load_ga_core_main():
    spec = importlib.util.spec_from_file_location("ga_core_main_under_test", GA_CORE_MAIN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _ReadOnlyAskFacade:
    """Stand-in for llmcore.MixinSession: node-specific names reject writes/deletes."""

    def __init__(self):
        object.__setattr__(self, "_sessions", [object()])
        self.seen = []

    def __setattr__(self, name, value):
        if name == "ask":
            raise AttributeError(f"MixinSession.{name} is node-specific and read-only")
        object.__setattr__(self, name, value)

    def __delattr__(self, name):
        if name == "ask":
            raise AttributeError(f"MixinSession.{name} is node-specific and read-only")
        object.__delattr__(self, name)

    def ask(self, msg, *args, **kwargs):
        self.seen.append(msg)
        yield "chunk"


def test_inject_images_survives_read_only_ask_facade(tmp_path):
    mod = _load_ga_core_main()
    img = tmp_path / "a.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    backend = _ReadOnlyAskFacade()
    undo = mod._inject_images(SimpleNamespace(backend=backend), [str(img)])

    assert callable(undo)
    assert "ask" in vars(backend)          # installed on the instance, guard bypassed
    msg = {"role": "user", "content": [{"type": "text", "text": "hi"}]}
    assert list(backend.ask(msg)) == ["chunk"]
    assert msg["content"][0] == {"type": "text", "text": "hi"}
    assert msg["content"][-1]["type"] == "image"
    assert backend.seen == [msg]

    undo()
    assert "ask" not in vars(backend)      # back to the node's own method
    assert backend.ask.__self__ is backend


def test_inject_images_restores_preexisting_instance_attr(tmp_path):
    mod = _load_ga_core_main()
    img = tmp_path / "b.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"1" * 32)
    calls = []

    def own(msg, *args, **kwargs):
        calls.append(msg)
        yield "own"

    backend = SimpleNamespace(ask=own)
    undo = mod._inject_images(SimpleNamespace(backend=backend), [str(img)])
    assert list(backend.ask({"content": []})) == ["own"]
    undo()
    assert backend.ask is own and calls and calls[0]["content"][0]["type"] == "image"
