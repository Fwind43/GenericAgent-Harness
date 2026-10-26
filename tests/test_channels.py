from ga_harness.channels import Adapter, Bindings, Hub, final_text, split_text


class FakeSessions:
    def __init__(self):
        self.items = {}

    def create(self, **kw):
        sid = f"s{len(self.items) + 1}"
        self.items[sid] = {"id": sid, **kw}
        return self.items[sid]

    def get(self, sid):
        return self.items.get(sid)


class FakeRuns:
    def __init__(self):
        self.started, self.active = [], {}

    def start(self, task, *, session_id=None, source="user", timeout=None):
        run = {"id": f"r{len(self.started) + 1}", "session_id": session_id, "source": source}
        self.started.append((task, run))
        return run

    def active_for(self, sid):
        return self.active.get(sid)

    def cancel(self, run_id):
        self.active = {k: v for k, v in self.active.items() if v["id"] != run_id}


class FakeAdapter(Adapter):
    name = "fake"

    def __init__(self):
        self.sent = []

    def send(self, chat_id, text):
        self.sent.append((chat_id, text))


def make_hub(tmp_path):
    runs, sessions = FakeRuns(), FakeSessions()
    return Hub(runs, sessions, Bindings(tmp_path / "channels.db")), runs, sessions


def test_split_text_respects_limit():
    parts = split_text("x" * 25, 10)
    assert parts and all(0 < len(p) <= 10 for p in parts)


def test_final_text_prefers_last_reply():
    msg = {"turns": [{"reply": "a"}, {"reply": "b"}, {"reply": ""}]}
    assert final_text(msg) == "b"
    assert final_text(None) == ""


def test_receive_starts_run_and_reuses_binding(tmp_path):
    hub, runs, sessions = make_hub(tmp_path)
    try:
        assert hub.receive("fake", 42, "hello") == "r1"
        assert hub.receive("fake", "42", "again") == "r2"
        sids = {run["session_id"] for _, run in runs.started}
        assert len(sids) == 1 and len(sessions.items) == 1
        assert runs.started[0][1]["source"] == "channel:fake"
    finally:
        hub.close()


def test_register_rejects_bad_names(tmp_path):
    hub, _, _ = make_hub(tmp_path)
    try:
        bad = FakeAdapter()
        bad.name = "a:b"
        try:
            hub.register(bad)
            assert False, "expected ValueError"
        except ValueError:
            pass
    finally:
        hub.close()
