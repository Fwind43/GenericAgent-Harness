"""Worldline keeps the conversation's current settings when it rewinds history."""
import importlib.util
from pathlib import Path

from ga_harness import model_keys

MAIN = Path(__file__).resolve().parents[1] / "ga_harness" / "plugins" / "worldline" / "main.py"


def _load():
    spec = importlib.util.spec_from_file_location("gah_worldline_main_test", MAIN)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Backend:
    def __init__(self, name):
        self.name = name


class _Client:
    def __init__(self, key, name):
        self.backend = _Backend(name)
        setattr(self, model_keys.ATTR, key)


def test_resend_resolves_to_the_model_selected_now():
    """The key wins in model_keys.find, so a checkpoint's key must not survive the rewind."""
    wl = _load()
    clients = [_Client("old_api", "old"), _Client("new_api", "new")]
    state = wl._keep_settings({"model": "old", "model_key": "old_api"},
                              {"model": "new", "model_key": "new_api"})
    index, client = model_keys.find(clients, state.get("model_key"), state.get("model"))
    assert (index, model_keys.key_of(client)) == (1, "new_api")


def test_keep_settings_carries_selected_model_key():
    wl = _load()
    checkpoint = {"model": "old", "model_key": "old_api", "effort": "low", "history": [1]}
    live = {"model": "new", "model_key": "new_api", "effort": "high", "history": [1, 2]}
    state = wl._keep_settings(checkpoint, live)
    assert state == {"model": "new", "model_key": "new_api", "effort": "high", "history": [1]}


def test_keep_settings_drops_stale_key_when_live_has_none():
    wl = _load()
    state = wl._keep_settings({"model": "old", "model_key": "old_api"}, {"model": "new"})
    assert state == {"model": "new"}


def test_branch_listing_uses_covering_index(tmp_path):
    wl = _load()
    store = wl.Store(tmp_path / "worldline.db")
    for text in ("first", "second"):
        store.archive("s1", 0, [{"role": "user", "text": text}], {})
    with store._db() as db:
        # Existing databases migrate on open, not only newly created archives.
        db.execute("DROP INDEX branch_listing")
    store = wl.Store(store.path)
    rows = store.rows("s1")
    assert len(rows) == 2
    assert all("messages" not in row and "state" not in row for row in rows)
    assert rows == sorted(rows, key=lambda r: (r["created"], r["id"]))
    with store._db() as db:
        plan = [r[3] for r in db.execute(
            "EXPLAIN QUERY PLAN SELECT id,idx,prefix,full,created FROM branches "
            "WHERE session_id=? ORDER BY created,id", ("s1",))]
    assert any("COVERING INDEX branch_listing" in detail for detail in plan)
    assert not any("TEMP B-TREE" in detail for detail in plan)
