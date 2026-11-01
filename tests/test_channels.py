from ga_harness.channels import HELP, Adapter, Bindings, Hub, final_text, split_text


class FakeSessions:
    def __init__(self):
        self.items = {}

    def create(self, **kw):
        sid = f"s{len(self.items) + 1}"
        self.items[sid] = {"id": sid, **kw}
        return self.items[sid]

    def get(self, sid):
        return self.items.get(sid)

    def remember_for(self, sid, **values):
        self.items[sid]["state"] = {**(self.items[sid].get("state") or {}), **values}


class FakeRuns:
    def __init__(self):
        self.started, self.active = [], {}

    def start(self, task, *, session_id=None, source="user", timeout=None, attachments=None):
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


MODELS = (("gpt-main", "gpt-5", "openai"), ("claude-a", "claude-sonnet", "anthropic"),
          ("claude-b", "claude-opus", "anthropic"))


class FakeModels:
    def __init__(self, rows=MODELS, current=0):
        self.items = [{"id": i, "name": n, "model": m, "provider": p}
                      for i, (n, m, p) in enumerate(rows)]
        self.current = current

    def catalog(self):
        return {"items": [dict(m) for m in self.items], "current": self.current}


def make_hub(tmp_path, models=None):
    runs, sessions = FakeRuns(), FakeSessions()
    hub = Hub(runs, sessions, Bindings(tmp_path / "channels.db"), models=models)
    return hub, runs, sessions


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


def test_model_command_lists_and_switches(tmp_path):
    hub, runs, sessions = make_hub(tmp_path, models=lambda: FakeModels())
    try:
        assert hub.command("fake", "42", "/model").splitlines() == [
            "模型：gpt-main（宿主默认）",
            "-> [0] gpt-main (openai)",
            "   [1] claude-a (anthropic)",
            "   [2] claude-b (anthropic)",
            "用 /model <编号|名称> 切换。"]
        assert not hub.bindings.get("fake", "42")
        assert hub.command("fake", "42", "/model 1") == "本聊天的模型：[1] claude-a。"
        sid = hub.bindings.get("fake", "42")
        assert sessions.get(sid)["state"]["model"] == "claude-a"
        assert hub.command("fake", "42", "/llm claude-b") == "本聊天的模型：[2] claude-b。"
        assert hub.bindings.get("fake", "42") == sid
        assert sessions.get(sid)["state"]["model"] == "claude-b"
        listing = hub.command("fake", "42", "/MODEL@bot").splitlines()
        assert listing[0] == "模型：claude-b"
        assert "-> [2] claude-b (anthropic)" in listing
    finally:
        hub.close()


def test_model_command_rejects_bad_picks(tmp_path):
    hub, runs, sessions = make_hub(tmp_path, models=FakeModels())
    try:
        assert hub.command("fake", "7", "/model claude") == (
            "'claude' 匹配到多个模型：[1] claude-a, [2] claude-b。请用编号选择。")
        assert hub.command("fake", "7", "/model x") == "未知模型 'x'。发送 /model 查看列表。"
        assert hub.command("fake", "7", "/model 7") == "没有编号为 7 的模型。发送 /model 查看列表。"
        assert not hub.bindings.get("fake", "7")
        assert hub.command("fake", "7", "/model 0") == "本聊天的模型：[0] gpt-main。"
        sid = hub.bindings.get("fake", "7")
        runs.active[sid] = {"id": "r9"}
        assert hub.command("fake", "7", "/model claude-a") == (
            "上一个任务还在运行，请等它结束后再修改设置。发送 /stop 可以取消。")
        assert sessions.get(sid)["state"]["model"] == "gpt-main"
    finally:
        hub.close()


def test_effort_command_sets_and_resets(tmp_path):
    hub, runs, sessions = make_hub(tmp_path)
    opts = "low, medium, high, xhigh, max, default"
    try:
        assert hub.command("fake", "5", "/effort") == f"推理强度：跟随宿主设置\n可选：{opts}"
        assert hub.command("fake", "5", "/effort Hi") == f"未知的推理强度 'Hi'。可选：{opts}"
        assert hub.bindings.get("fake", "5") is None
        assert hub.command("fake", "5", "/EFFORT@bot HIGH") == "本聊天的推理强度：high。"
        sid = hub.bindings.get("fake", "5")
        assert sessions.get(sid)["state"]["effort"] == "high"
        assert hub.command("fake", "5", "/effort reset") == "本聊天的推理强度：default。"
        assert sessions.get(sid)["state"]["effort"] is None
        assert hub.command("fake", "5", "/effort") == f"推理强度：default\n可选：{opts}"
        runs.active[sid] = {"id": "r9"}
        assert hub.command("fake", "5", "/effort low").startswith("上一个任务还在运行")
        assert sessions.get(sid)["state"]["effort"] is None
    finally:
        hub.close()


def test_status_and_stop_commands(tmp_path):
    hub, runs, _ = make_hub(tmp_path)
    try:
        assert hub.command("fake", "9", "/status") == "还没有会话。"
        assert hub.command("fake", "9", "/stop") == "当前没有正在运行的任务。"
        assert hub.bindings.get("fake", "9") is None
        assert hub.command("fake", "9", "/effort max") == "本聊天的推理强度：max。"
        sid = hub.bindings.get("fake", "9")
        status = hub.command("fake", "9", "/status")
        assert status.startswith(f"会话 {sid}（空闲）\n标题：")
        assert status.endswith("\n模型：宿主默认\n推理强度：max")
        runs.active[sid] = {"id": "r9"}
        assert hub.command("fake", "9", "/status").startswith(f"会话 {sid}（运行中）\n")
        assert hub.command("fake", "9", "/STOP@bot") == "正在取消。"
        assert runs.active_for(sid) is None
        assert hub.command("fake", "9", "/stop") == "当前没有正在运行的任务。"
        assert hub.command("fake", "9", "/unknown") is None
    finally:
        hub.close()


def test_new_command_keeps_and_drops_stale_model(tmp_path):
    models = FakeModels()
    hub, _, sessions = make_hub(tmp_path, models=models)
    try:
        assert hub.command("fake", "5", "/new") == "已新建会话。"
        first = hub.bindings.get("fake", "5")
        assert "state" not in sessions.get(first)
        hub.command("fake", "5", "/model 2")
        hub.command("fake", "5", "/effort high")
        assert hub.command("fake", "5", "/new") == "已新建会话。"
        second = hub.bindings.get("fake", "5")
        assert second != first
        assert sessions.get(second)["state"] == {"model": "claude-b", "effort": "high"}
        models.items = models.items[:2]
        assert hub.command("fake", "5", "/status").splitlines()[1] == (
            "模型：claude-b（已不在配置中，请用 /model 另选）")
        assert hub.command("fake", "5", "/new") == (
            "已新建会话。"
            "模型 claude-b 已不在配置中，改用默认模型。")
        third = hub.bindings.get("fake", "5")
        assert sessions.get(third)["state"] == {"effort": "high"}
        assert sessions.get(second)["state"]["model"] == "claude-b"
        assert hub.command("fake", "5", "/status").splitlines()[1:] == [
            "模型：gpt-main（宿主默认）", "推理强度：high"]
    finally:
        hub.close()


def test_receive_refuses_removed_model_until_repicked(tmp_path):
    models = FakeModels()
    hub, runs, _ = make_hub(tmp_path, models=models)
    replies = []
    hub.reply = lambda channel, chat, text: replies.append((chat, text))
    try:
        assert hub.command("fake", "9", "/model claude-b") == "本聊天的模型：[2] claude-b。"
        models.items = models.items[:2]
        assert hub.receive("fake", "9", "hello") is None
        assert runs.started == []
        assert replies == [("9", "模型 claude-b 已不在配置中。请用 /model 另选一个，"
                                 "或发送 /new 使用默认模型。")]
        hub.command("fake", "9", "/model claude-a")
        assert hub.receive("fake", "9", "hello") == "r1"
        models.items = []  # no catalog to check against: the run goes ahead
        assert hub.receive("fake", "9", "again") == "r2"
        assert len(replies) == 1
    finally:
        hub.close()


def test_commands_without_catalog_and_help(tmp_path):
    unavailable = "无法切换模型：模型目录未加载。"

    def broken():
        raise RuntimeError("model-store failed to start")

    assert [line.split()[0] for line in HELP.splitlines()] == [
        "/new", "/sessions", "/use", "/stop", "/status", "/model", "/effort", "/help"]
    for n, models in enumerate((None, broken, lambda: FakeModels(rows=()))):
        (tmp_path / str(n)).mkdir()
        hub, _, _ = make_hub(tmp_path / str(n), models=models)
        try:
            assert hub.command("fake", "7", "/help") == HELP
            assert hub.command("fake", "7", "/HELP@bot") == HELP
            for text in ("/model", "/llm", "/model 1", "/LLM@bot claude-a"):
                assert hub.command("fake", "7", text) == unavailable
            assert hub.bindings.get("fake", "7") is None
            assert hub.command("fake", "7", "/new") == "已新建会话。"
            assert hub.bindings.get("fake", "7")
            assert hub.command("fake", "7", "/model gpt-main") == unavailable
        finally:
            hub.close()
