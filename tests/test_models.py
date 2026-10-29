"""Synthetic credentials only; no user configuration or network access."""
import copy
import json
import queue
from types import SimpleNamespace as NS

import pytest

from ga_harness import llmconfig
from ga_harness.models import Models, _mykey_source


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


class MykeyTestSource:
    """Reload only the synthetic mykey fixture, like GA's native loader."""
    def __init__(self, path):
        self.path = self.file = path

    def load(self):
        data = llmconfig.read_mykey_py(self.path)
        data.pop("_skipped", None)
        return llmconfig._expand(llmconfig.resolve_providers(data))


class MykeyModels(Models):
    """Models bound to a synthetic mykey.py instead of GA's imported module."""
    def __init__(self, agent):
        super().__init__(agent)
        self.source = agent.source

    def _file(self):
        return self.source.file

    def _group_of(self):
        # GA groups from the imported mykey module; expose the fixture as that module.
        import sys
        import types
        saved = sys.modules.get("mykey")
        mod = types.ModuleType("mykey")
        vars(mod).update(read_cfg(self.source.file))
        sys.modules["mykey"] = mod
        try:
            return super()._group_of()
        finally:
            if saved is None:
                sys.modules.pop("mykey", None)
            else:
                sys.modules["mykey"] = saved


def read_cfg(path):
    data = llmconfig.read_mykey_py(path)
    data.pop("_skipped", None)
    return data


def write_mykey(path, data):
    path.write_text("".join(f"{k} = {v!r}\n" for k, v in data.items()), encoding="utf-8")


def make_models(tmp_path):
    data = {"native_oai_config_one": {"name": "One", "model": "test-one",
            "apibase": "https://example.invalid/v1", "apikey": "test-secret-one",
            "context_win": 8192, "temperature": 0.3}, "unrelated": {"keep": True}}
    path = tmp_path / "mykey.py"
    write_mykey(path, data)
    return MykeyModels(ModelAgent(MykeyTestSource(path)))


def make_fallback(tmp_path):
    mykey = tmp_path / "mykey.py"
    mykey.write_text('native_oai_config_x = {"name": "X", "model": "m-x", "apibase": "https://example.invalid/v1", '
                     '"apikey": "test-secret-x"}\nproxy = "http://127.0.0.1:1"\n', encoding="utf-8")
    return MykeyModels(ModelAgent(MykeyTestSource(mykey))), None, mykey


def change(store, action="save", key="native_oai_config_one", values=None):
    return store.change({"action": action, "key": key, "values": values or {},
                         "revision": store.config()["revision"]})


def test_crud_preserves_secrets_fields_history_and_cold_reload(tmp_path):
    store = make_models(tmp_path)
    store.agent.llmclient.backend.history = [{"role": "user", "content": "kept"}]
    public = store.config()
    assert "test-secret" not in json.dumps(public)
    assert public["entries"][0]["has_key"]
    change(store, values={"name": "Renamed", "apikey": ""})
    data = read_cfg(store.source.file)
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
    cold = MykeyModels(ModelAgent(store.source))
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
    assert read_cfg(store.source.file)["native_oai_config_one"]["apikey"] == "${GAH_TEST_ONLY_KEY}"
    assert "synthetic-env-secret" not in json.dumps(store.config())
    data = read_cfg(store.source.file)
    data["native_oai_config_one"]["apibase"] = "https://user:secret@example.invalid/v1"
    write_mykey(store.source.file, data)
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
    data = read_cfg(store.source.file)
    data["native_oai_config_one"]["apibase"] = url
    write_mykey(store.source.file, data)
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


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_mykey_crud_preserves_helpers_secrets_and_history(tmp_path, newline):
    store, _, mykey = make_fallback(tmp_path)
    header = "# preserved comment\nimport math\ndef helper():\n    return math.pi\n\n".replace("\n", newline)
    tail = mykey.read_text(encoding="utf-8").replace("\n", newline)
    untouched = "# untouched model" + newline + "native_claude_config_keep = " + repr({
        "model": "keep", "apibase": "https://example.invalid/v1", "apikey": "test-secret-keep"}) + newline
    mykey.write_bytes((header + tail + untouched).encode("utf-8"))
    store.agent.load_llm_sessions()
    store.agent.llmclient.backend.history = [{"role": "user", "content": "kept"}]
    out = change(store, key="native_oai_config_x", values={"model": "updated", "apikey": "", "provider": ""})
    data = llmconfig.read_mykey_py(mykey)
    assert data["native_oai_config_x"]["model"] == "updated"
    assert data["native_oai_config_x"]["apikey"] == "test-secret-x"
    assert data["proxy"] == "http://127.0.0.1:1"
    assert "test-secret" not in json.dumps(out)
    text = mykey.read_bytes().decode("utf-8")
    assert text.startswith(header) and untouched in text
    if newline == "\r\n":
        assert "\n" not in text.replace("\r\n", "")
    change(store, key="native_oai_config_new", values={"name": "New", "model": "new",
           "apibase": "https://example.invalid/v1", "apikey": "test-secret-new"})
    assert len(store.catalog()["items"]) == 3
    assert store.agent.llmclient.backend.history == [{"role": "user", "content": "kept"}]
    cold = MykeyModels(ModelAgent(MykeyTestSource(mykey)))
    assert len(cold.catalog()["items"]) == 3
    change(store, "delete", key="native_oai_config_new")
    assert "native_oai_config_new" not in llmconfig.read_mykey_py(mykey)
    assert mykey.read_bytes().startswith(header.encode("utf-8"))
    assert untouched.encode("utf-8") in mykey.read_bytes()


def test_mykey_busy_revision_and_reload_failure_restore_bytes(tmp_path):
    store, _, mykey = make_fallback(tmp_path)
    original = mykey.read_bytes()
    clients, active = store.agent.llmclients, store.agent.llmclient
    revision = store.config()["revision"]
    store.agent.is_running = True
    with pytest.raises(RuntimeError, match="running"):
        change(store, key="native_oai_config_x", values={"model": "blocked"})
    store.agent.is_running = False
    assert mykey.read_bytes() == original
    store.agent.fail_reload = True
    with pytest.raises(RuntimeError, match="restored"):
        change(store, key="native_oai_config_x", values={"model": "not-saved"})
    assert mykey.read_bytes() == original
    assert store.agent.llmclients is clients and store.agent.llmclient is active
    mykey.write_bytes(original + b"# externally edited\n")
    with pytest.raises(RuntimeError, match="changed"):
        store.change({"action": "save", "key": "native_oai_config_x", "revision": revision,
                      "values": {"model": "not-saved"}})
    assert mykey.read_bytes() == original + b"# externally edited\n"


def _native_provider_change(store, action="provider_save", pid="shared", values=None):
    return store.change({"action": action, "id": pid, "values": values or {},
                         "revision": store.config()["revision"]})


def test_mykey_provider_crud_syncs_native_models_and_cold_reload(tmp_path):
    store, _, mykey = make_fallback(tmp_path)
    untouched = ("# preserve unrelated credentials and helpers\n"
                 "def helper():\n    return 42\n"
                 "native_claude_config_keep = " + repr({
                     "model": "keep", "apibase": "https://shared.invalid/v1",
                     "apikey": "test-shared-secret", "temperature": 0.7}) + "\n")
    mykey.write_bytes(mykey.read_bytes() + untouched.encode("utf-8"))
    store.agent.load_llm_sessions()
    history = [{"role": "user", "content": "kept"}]
    store.agent.llmclient.backend.history = history
    public = _native_provider_change(store, values={
        "name": "Shared", "protocol": "oai", "apibase": "https://shared.invalid/v1",
        "apikey": "test-shared-secret"})
    assert public["format"] == "mykey"
    assert public["providers"][0]["id"] == "shared"
    assert "test-shared-secret" not in json.dumps(public)
    change(store, key="native_oai_config_x", values={"provider": "shared"})
    change(store, key="native_claude_config_new", values={
        "provider": "shared", "model": "claude-new", "context_win": 32768})
    data = llmconfig.read_mykey_py(mykey)
    assert data[llmconfig.MYKEY_MODEL_PROVIDERS] == {
        "native_oai_config_x": "shared", "native_claude_config_new": "shared"}
    for key in ("native_oai_config_x", "native_claude_config_new"):
        assert "provider" not in data[key]
        assert "protocol" not in data[key]
        assert data[key]["apibase"] == "https://shared.invalid/v1"
        assert data[key]["apikey"] == "test-shared-secret"
    assert llmconfig.MYKEY_MODEL_PROVIDERS not in llmconfig.resolve_providers(data)
    assert store.agent.llmclient.backend.history == history
    cold = MykeyModels(ModelAgent(MykeyTestSource(mykey)))
    entries = {item["key"]: item for item in cold.config()["entries"]}
    assert entries["native_oai_config_x"]["provider"] == "shared"
    assert entries["native_claude_config_new"]["provider"] == "shared"
    assert entries["native_claude_config_new"]["protocol"] == "claude"
    assert entries["native_claude_config_keep"]["provider"] is None
    _native_provider_change(store, values={
        "name": "Renamed", "protocol": "claude", "apibase": "https://changed.invalid/v1",
        "apikey": ""})
    data = llmconfig.read_mykey_py(mykey)
    for key in ("native_oai_config_x", "native_claude_config_new"):
        assert data[key]["apibase"] == "https://changed.invalid/v1"
        assert data[key]["apikey"] == "test-shared-secret"
        assert "provider" not in data[key] and "protocol" not in data[key]
    assert data["native_claude_config_new"]["context_win"] == 32768
    assert data["native_claude_config_keep"]["apibase"] == "https://shared.invalid/v1"
    assert untouched.encode("utf-8") in mykey.read_bytes()
    original = mykey.read_bytes()
    with pytest.raises(ValueError, match="remove or move"):
        _native_provider_change(store, "provider_delete")
    assert mykey.read_bytes() == original
    change(store, key="native_oai_config_x", values={"provider": ""})
    data = llmconfig.read_mykey_py(mykey)
    assert data["native_oai_config_x"]["apikey"] == "test-shared-secret"
    assert data[llmconfig.MYKEY_MODEL_PROVIDERS] == {"native_claude_config_new": "shared"}
    change(store, "delete", key="native_claude_config_new")
    _native_provider_change(store, "provider_delete")
    data = llmconfig.read_mykey_py(mykey)
    assert llmconfig.PROVIDERS not in data and llmconfig.MYKEY_MODEL_PROVIDERS not in data
    assert untouched.encode("utf-8") in mykey.read_bytes()


def test_mykey_provider_move_updates_native_credentials(tmp_path):
    store, _, mykey = make_fallback(tmp_path)
    for pid in ("first", "second"):
        _native_provider_change(store, pid=pid, values={
            "apibase": f"https://{pid}.invalid/v1", "apikey": f"test-{pid}-secret"})
    change(store, key="native_oai_config_x", values={"provider": "first"})
    change(store, key="native_oai_config_x", values={"provider": "second"})
    data = llmconfig.read_mykey_py(mykey)
    assert data[llmconfig.MYKEY_MODEL_PROVIDERS] == {"native_oai_config_x": "second"}
    assert data["native_oai_config_x"]["apibase"] == "https://second.invalid/v1"
    assert data["native_oai_config_x"]["apikey"] == "test-second-secret"
    _native_provider_change(store, "provider_delete", pid="first")


def test_mykey_provider_reload_failure_restores_file_and_active_model(tmp_path):
    store, _, mykey = make_fallback(tmp_path)
    _native_provider_change(store, values={
        "apibase": "https://shared.invalid/v1", "apikey": "test-shared-secret"})
    change(store, key="native_oai_config_x", values={"provider": "shared"})
    original = mykey.read_bytes()
    clients, active = store.agent.llmclients, store.agent.llmclient
    store.agent.fail_reload = True
    with pytest.raises(RuntimeError, match="restored"):
        _native_provider_change(store, values={"apibase": "https://not-saved.invalid/v1"})
    assert mykey.read_bytes() == original
    assert store.agent.llmclients is clients and store.agent.llmclient is active


@pytest.mark.parametrize("mapping", [
    [], {"native_oai_config_x": "missing"}, {"native_oai_config_missing": "shared"},
    {"native_oai_config_x": []},
])
def test_mykey_invalid_provider_mapping_refuses_edits(tmp_path, mapping):
    store, _, mykey = make_fallback(tmp_path)
    _native_provider_change(store, values={
        "apibase": "https://shared.invalid/v1", "apikey": "test-shared-secret"})
    mykey.write_bytes(mykey.read_bytes() + (
        llmconfig.MYKEY_MODEL_PROVIDERS + " = " + repr(mapping) + "\n").encode("utf-8"))
    original = mykey.read_bytes()
    with pytest.raises(ValueError, match="mapping is invalid"):
        store.change({"action": "save", "key": "native_oai_config_x",
                      "values": {"model": "not-saved"}, "revision": store._read(logical=False)[3]})
    assert mykey.read_bytes() == original


def test_mykey_dynamic_provider_metadata_is_not_rewritten(tmp_path):
    store, _, mykey = make_fallback(tmp_path)
    mykey.write_bytes(mykey.read_bytes() + (
        "providers = dict(shared={'apibase': 'https://shared.invalid/v1', "
        "'apikey': 'test-shared-secret'})\n").encode("utf-8"))
    original = mykey.read_bytes()
    with pytest.raises(ValueError, match="computed dynamically"):
        _native_provider_change(store, values={"name": "Not saved"})
    assert mykey.read_bytes() == original


@pytest.mark.parametrize("source", [
    "cfg = {'model': 'old'}\ncfg = {'model': 'old'}\n",
    "cfg = alias = {'model': 'old'}\n",
    "cfg = {'model': 'old'}; side_effect = 1\n",
    "if True:\n    cfg = {'model': 'old'}\n",
    "cfg = dict(model='old')\n",
])
def test_mykey_source_rejects_ambiguous_or_dynamic_definitions(source):
    before = {"cfg": {"model": "old"}}
    after = {"cfg": {"model": "new"}}
    with pytest.raises(ValueError):
        _mykey_source(source.encode(), before, after, "synthetic-mykey.py")


def test_mykey_source_invalid_or_changed_dependencies_are_rejected():
    with pytest.raises(ValueError, match="syntax error"):
        _mykey_source(b"cfg = {", {"cfg": {}}, {"cfg": {"model": "new"}}, "synthetic-mykey.py")
    source = b"cfg = {'model': 'old'}\ncfg.update(model='dynamic')\n"
    with pytest.raises(ValueError, match="dynamically"):
        _mykey_source(source, {"cfg": {"model": "dynamic"}}, {"cfg": {"model": "new"}}, "synthetic-mykey.py")


def test_mykey_source_preserves_bom_and_trailing_comment():
    source = "\ufeff# non-ASCII \u4fdd\u7559\ncfg = {'model': 'old'}  # retain this note\n"
    out = _mykey_source(source.encode("utf-8"), {"cfg": {"model": "old"}},
                        {"cfg": {"model": "new"}}, "synthetic-mykey.py")
    assert out.startswith("\ufeff# non-ASCII \u4fdd\u7559\n".encode("utf-8"))
    assert b"# retain this note" in out


def make_mixin_models(tmp_path):
    store = make_models(tmp_path)
    change(store, key="native_oai_config_two", values={
        "name": "Two", "model": "test-two", "apibase": "https://example.invalid/v1",
        "apikey": "test-secret-two"})
    return store


def save_mixin(store, members=None, **options):
    return change(store, action="mixin_save", key="mixin_config_main",
                  values={"llm_nos": ["One", "Two"] if members is None else members, **options})


def test_mixin_crud_order_defaults_and_unrelated_fields(tmp_path):
    store = make_mixin_models(tmp_path)
    result = save_mixin(store, max_retries=4, base_delay=0.5, spring_back=0)
    assert result["mixins"] == [{"key": "mixin_config_main", "members": ["One", "Two"],
                                 "indexed": False, "values": {
                                     "max_retries": 4, "base_delay": 0.5, "spring_back": 0}}]
    data = read_cfg(store.source.file)
    assert data["native_oai_config_one"]["apikey"] == "test-secret-one"
    data["mixin_config_main"]["custom_field"] = "keep"
    write_mykey(store.source.file, data)
    save_mixin(store, ["Two", "One"], max_retries=None, base_delay="", spring_back=None)
    assert read_cfg(store.source.file)["mixin_config_main"] == {
        "llm_nos": ["Two", "One"], "custom_field": "keep"}
    result = change(store, action="mixin_delete", key="mixin_config_main")
    assert result["mixins"] == []
    assert "mixin_config_main" not in read_cfg(store.source.file)


@pytest.mark.parametrize("values", [
    {"llm_nos": ["One"]}, {"llm_nos": ["One", "One"]},
    {"llm_nos": ["One", "Missing"]}, {"llm_nos": [0, 1]},
    {"llm_nos": ["One", "Two"], "max_retries": True},
    {"llm_nos": ["One", "Two"], "max_retries": 1.5},
    {"llm_nos": ["One", "Two"], "max_retries": 21},
    {"llm_nos": ["One", "Two"], "base_delay": -1},
    {"llm_nos": ["One", "Two"], "spring_back": 86401},
    {"llm_nos": ["One", "Two"], "unknown_option": 1},
])
def test_mixin_invalid_fields_do_not_write(tmp_path, values):
    store = make_mixin_models(tmp_path)
    original = store.source.file.read_bytes()
    with pytest.raises(ValueError):
        change(store, action="mixin_save", key="mixin_config_main", values=values)
    assert store.source.file.read_bytes() == original


def test_mixin_requires_unique_names_and_compatible_types(tmp_path):
    store = make_mixin_models(tmp_path)
    data = read_cfg(store.source.file)
    data["native_oai_config_two"]["name"] = "One"
    with pytest.raises(ValueError, match="unique"):
        store._mixin_change(data, "mixin_save", {
            "key": "mixin_config_main", "values": {"llm_nos": ["One", "Two"]}})
    data["oai_config_plain"] = dict(data.pop("native_oai_config_two"), name="Plain")
    with pytest.raises(ValueError, match="cannot mix"):
        store._mixin_change(data, "mixin_save", {
            "key": "mixin_config_main", "values": {"llm_nos": ["One", "Plain"]}})
    assert "mixin_config_main" not in data


def test_mixin_rename_references_and_delete_protection(tmp_path):
    store = make_mixin_models(tmp_path)
    save_mixin(store)
    change(store, values={"name": "Renamed"})
    assert read_cfg(store.source.file)["mixin_config_main"]["llm_nos"] == ["Renamed", "Two"]
    original = store.source.file.read_bytes()
    with pytest.raises(ValueError, match="used by failover"):
        change(store, action="delete")
    with pytest.raises(ValueError, match="ambiguous"):
        change(store, values={"name": "Two"})
    with pytest.raises(ValueError, match="ambiguous"):
        change(store, key="native_oai_config_duplicate", values={
            "name": "Two", "model": "duplicate", "apibase": "https://example.invalid/v1",
            "apikey": "test-duplicate"})
    assert store.source.file.read_bytes() == original


def test_mixin_numeric_indices_are_not_guessed_and_block_model_deletion(tmp_path):
    store = make_mixin_models(tmp_path)
    data = read_cfg(store.source.file)
    data["mixin_config_main"] = {"llm_nos": [0, 9]}
    write_mykey(store.source.file, data)
    entry = store.config()["mixins"][0]
    assert entry["members"] == ["#0", "#9"] and entry["indexed"]
    original = store.source.file.read_bytes()
    with pytest.raises(ValueError, match="by position"):
        change(store, action="delete")
    assert store.source.file.read_bytes() == original
    save_mixin(store)
    assert not store.config()["mixins"][0]["indexed"]
    assert read_cfg(store.source.file)["mixin_config_main"]["llm_nos"] == ["One", "Two"]


def test_mixin_reload_failure_restores_file_and_active_model(tmp_path):
    store = make_mixin_models(tmp_path)
    original = store.source.file.read_bytes()
    active = store.agent.llmclient
    store.agent.fail_reload = True
    with pytest.raises(RuntimeError, match="restored"):
        save_mixin(store)
    assert store.source.file.read_bytes() == original
    assert store.agent.llmclient is active
