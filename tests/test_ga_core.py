import textwrap
import uuid

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
