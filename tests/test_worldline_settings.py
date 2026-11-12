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
