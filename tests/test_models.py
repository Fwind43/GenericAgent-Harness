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
