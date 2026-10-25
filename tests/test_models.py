"""Synthetic credentials only; no user configuration or network access."""
import copy
import json
import queue
from types import SimpleNamespace as NS

import pytest

from ga_harness import llmconfig
from ga_harness.models import Models


class ModelAgent:
    def __init__(self, source):
        self.source = source
        self.task_queue = queue.Queue()
        self.is_running = False
        self.llm_no = 0
        self.fail_reload = False
        self.load_llm_sessions()

    def load_llm_sessions(self):
        if self.fail_reload:
            self.fail_reload = False
            raise RuntimeError("synthetic reload failure")
        old = getattr(self, "llmclient", None)
        clients = []
        for key, cfg in self.source.load().items():
            if not isinstance(cfg, dict) or not ("oai" in key or "claude" in key):
                continue
            clients.append(NS(backend=NS(name=cfg.get("name") or cfg["model"],
                                         model=cfg["model"], history=[]), last_tools=""))
        self.llmclients = clients
        if clients:
            names = [c.backend.name for c in clients]
            if old and old.backend.name in names:
                self.llm_no = names.index(old.backend.name)
            self.llmclient = clients[self.llm_no % len(clients)]
            if old:
                self.llmclient.backend.history = old.backend.history

    def next_llm(self, index):
        self.load_llm_sessions()
        history = self.llmclient.backend.history
        self.llm_no = index % len(self.llmclients)
        self.llmclient = self.llmclients[self.llm_no]
        self.llmclient.backend.history = history
        self.llmclient.last_tools = ""


def make_models(tmp_path, suffix=".toml"):
    data = {"native_oai_config_one": {"name": "One", "model": "test-one",
            "apibase": "https://example.invalid/v1", "apikey": "test-secret-one",
            "context_win": 8192, "temperature": 0.3}, "unrelated": {"keep": True}}
    path = tmp_path / ("models" + suffix)
    path.write_text(json.dumps(data) if suffix == ".json" else llmconfig.to_toml(data), encoding="utf-8")
    source = llmconfig.Source(path)
    return Models(ModelAgent(source), source)


def change(store, action="save", key="native_oai_config_one", values=None):
    return store.change({"action": action, "key": key, "values": values or {},
                         "revision": store.config()["revision"]})


@pytest.mark.parametrize("suffix", [".toml", ".json"])
def test_crud_preserves_secrets_fields_history_and_cold_reload(tmp_path, suffix):
    store = make_models(tmp_path, suffix)
    store.agent.llmclient.backend.history = [{"role": "user", "content": "kept"}]
    public = store.config()
    assert "test-secret" not in json.dumps(public)
    assert public["entries"][0]["has_key"]
    change(store, values={"name": "Renamed", "apikey": ""})
    data = llmconfig.read_file(store.source.file)
    assert data["native_oai_config_one"]["apikey"] == "test-secret-one"
    assert data["native_oai_config_one"]["temperature"] == 0.3
    assert data["unrelated"] == {"keep": True}
    second = {"name": "Two", "model": "test-two", "apibase": "https://example.invalid/v1",
              "apikey": "test-secret-two", "context_win": 16384}
    change(store, key="native_claude_config_two", values=second)
    assert len(store.catalog()["items"]) == 2
    assert store.select(1)["current"] == 1
    assert store.agent.llmclient.backend.history == [{"role": "user", "content": "kept"}]
    change(store, action="delete")
    cold = Models(ModelAgent(store.source), store.source)
    assert cold.catalog()["items"][0]["name"] == "Two"
    with pytest.raises(ValueError, match="at least one"):
        change(store, action="delete", key="native_claude_config_two")


def test_busy_revision_and_failed_reload_preserve_state(tmp_path):
    store = make_models(tmp_path)
    original = store.source.file.read_bytes()
    old = store.agent.llmclient
    revision = store.config()["revision"]
    store.agent.task_queue.put("pending")
    with pytest.raises(RuntimeError, match="running"):
        store.select(0)
    with pytest.raises(RuntimeError, match="running"):
        change(store, values={"name": "blocked"})
    store.agent.task_queue.get()
    store.agent.task_queue.task_done()
    store.agent.fail_reload = True
    with pytest.raises(RuntimeError, match="restored"):
        change(store, values={"name": "not saved"})
    assert store.source.file.read_bytes() == original
    assert store.agent.llmclient is old
    change(store, values={"name": "new"})
    with pytest.raises(RuntimeError, match="changed"):
        store.change({"action": "delete", "key": "native_oai_config_one", "revision": revision})
    assert len(store.config()["entries"]) == 1


@pytest.mark.parametrize("values", [{"model": ""}, {"context_win": True}, {"context_win": 1},
    {"apibase": "file:///tmp/key"}, {"apibase": "https://user:secret@example.invalid"},
    {"apibase": "https://example.invalid/?key=secret"}, {"unknown": "x"}])
def test_invalid_update_is_non_mutating(tmp_path, values):
    store = make_models(tmp_path)
    before = store.source.file.read_bytes()
    with pytest.raises(ValueError):
        change(store, values=values)
    assert store.source.file.read_bytes() == before


def test_env_reference_readonly_and_sensitive_url(tmp_path, monkeypatch):
    store = make_models(tmp_path)
    monkeypatch.setenv("GAH_TEST_ONLY_KEY", "synthetic-env-secret")
    change(store, values={"apikey": "${GAH_TEST_ONLY_KEY}"})
    change(store, values={"apikey": "", "name": "ENV"})
    assert llmconfig.read_file(store.source.file)["native_oai_config_one"]["apikey"] == "${GAH_TEST_ONLY_KEY}"
    assert "synthetic-env-secret" not in json.dumps(store.config())
    store.source.inline = {"extra": True}
    assert not store.config()["writable"]
    with pytest.raises(ValueError, match="inline"):
        store.change({"action": "save", "key": "native_oai_config_one", "values": {}})
    assert not Models(store.agent).config()["writable"]
    store.source.inline = {}
    data = llmconfig.read_file(store.source.file)
    data["native_oai_config_one"]["apibase"] = "https://user:secret@example.invalid/v1"
    store.source.file.write_text(llmconfig.to_toml(data), encoding="utf-8")
    assert store.config()["entries"][0]["url_hidden"]
    assert "secret" not in json.dumps(store.config())


@pytest.mark.parametrize(("url", "hidden"), [
    ("https://user:synthetic-leak@${GAH_HOST}/v1", True),
    ("https://${GAH_HOST}/v1?key=synthetic-leak", True),
    ("https://${GAH_HOST}/v1#synthetic-leak", True),
    ("${GAH_BASE:-https://user:synthetic-leak@example.invalid}", True),
    ("https://example.invalid/${GAH_PATH:-synthetic-leak}", True),
    ("${GAH_BASE}", False),
    ("https://${GAH_HOST}/v1", False),
    ("https://example.invalid/v1", False),
])
def test_url_templates_never_bypass_redaction(tmp_path, url, hidden):
    store = make_models(tmp_path)
    data = llmconfig.read_file(store.source.file)
    data["native_oai_config_one"]["apibase"] = url
    store.source.file.write_text(llmconfig.to_toml(data), encoding="utf-8")
    result = store.config()
    entry = result["entries"][0]
    assert entry["url_hidden"] is hidden
    assert ("apibase" not in entry["values"]) is hidden
    assert "synthetic-leak" not in json.dumps(result)
    if not hidden:
        assert entry["values"]["apibase"] == url


@pytest.mark.parametrize("index", [True, -1, 3, "0", None])
def test_invalid_selection(tmp_path, index):
    store = make_models(tmp_path)
    with pytest.raises(ValueError):
        store.select(index)
    assert store.catalog()["current"] == 0


class StubFallback(llmconfig.Fallback):
    def __init__(self, target, mykey, agent):
        super().__init__(target)
        self.mykey, self.agent, self.committed, self.undone = mykey, agent, [], []

    def mykey_path(self):
        return self.mykey

    def adopt(self):
        src = llmconfig.Source(self.target)
        self.prev, self.agent.source = self.agent.source, src
        return src, "finder"

    def undo(self, finder):
        self.agent.source = self.prev
        self.undone.append(finder)

    def commit(self, finder):
        self.committed.append(finder)


def make_fallback(tmp_path):
    mykey = tmp_path / "mykey.py"
    mykey.write_text('native_oai_config_x = {"name": "X", "model": "m-x", "apibase": "https://example.invalid/v1", '
                     '"apikey": "test-secret-x"}\nproxy = "http://127.0.0.1:1"\n', encoding="utf-8")
    agent = ModelAgent(llmconfig.Source(inline=llmconfig.read_mykey_py(mykey)))
    fb = StubFallback(tmp_path / "gah" / "llm.toml", mykey, agent)
    return Models(agent, None, fb), fb, mykey


def test_readonly_ga_mykey_explains_and_converts(tmp_path):
    store, fb, mykey = make_fallback(tmp_path)
    before = mykey.read_bytes()
    cfg = store.config()
    assert cfg["writable"] is False and cfg["reason_code"] == "ga_mykey"
    assert cfg["convert"] == {"target": str(fb.target), "blocked": False}
    store.agent.llmclient.backend.history = [{"role": "user", "content": "kept"}]
    out = store.change({"action": "convert"})
    assert out["writable"] is True and "convert" not in out
    assert [e["key"] for e in out["entries"]] == ["native_oai_config_x"]
    assert "test-secret-x" not in json.dumps(out)
    assert llmconfig.Source(fb.target).load()["proxy"] == "http://127.0.0.1:1"
    assert mykey.read_bytes() == before and fb.committed == ["finder"]
    assert store.agent.llmclient.backend.history == [{"role": "user", "content": "kept"}]
    with pytest.raises(ValueError):
        store.convert()
    change(store, values={"name": "Y", "model": "m-y", "apibase": "https://example.invalid/v1", "apikey": "k"},
           key="native_oai_config_y")
    assert "native_oai_config_y" in llmconfig.Source(fb.target).load()


def test_convert_refuses_existing_target_and_rolls_back(tmp_path):
    store, fb, _ = make_fallback(tmp_path)
    fb.target.parent.mkdir()
    fb.target.write_text("# user file\n", encoding="utf-8")
    assert store.config()["convert"]["blocked"] is True
    with pytest.raises(ValueError):
        store.convert()
    assert fb.target.read_text(encoding="utf-8") == "# user file\n"
    fb.target.unlink()
    store.agent.fail_reload = True
    clients = store.agent.llmclients
    with pytest.raises(RuntimeError):
        store.convert()
    assert not fb.target.exists() and fb.undone == ["finder"] and not fb.committed
    assert store.agent.llmclients is clients and store.source is None
    assert store.config()["reason_code"] == "ga_mykey"


def test_real_fallback_switches_mykey_module(tmp_path):
    import sys
    target = tmp_path / "llm.toml"
    target.write_text(llmconfig.to_toml({"native_oai_config_z": {"model": "z"}}), encoding="utf-8")
    fb = llmconfig.Fallback(target)
    saved = sys.modules.pop("mykey", None)
    try:
        src, finder = fb.adopt()
        import mykey
        assert mykey.native_oai_config_z == {"model": "z"} and mykey.__file__ == str(target)
        fb.undo(finder)
        assert finder not in sys.meta_path and "mykey" not in sys.modules
    finally:
        sys.modules.pop("mykey", None)
        if saved is not None:
            sys.modules["mykey"] = saved
