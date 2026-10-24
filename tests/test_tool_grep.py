from test_ga_tools_prompt import _mount


def test_grep_tool_registered_searches_and_unregisters(tmp_path):
    proj = tmp_path / "proj"
    (proj / "pkg").mkdir(parents=True)
    (proj / "pkg" / "a.py").write_text("x = 1\nNEEDLE = 2\n", encoding="utf-8")
    (proj / "b.txt").write_text("needle here\n", encoding="utf-8")
    (proj / "node_modules").mkdir()
    (proj / "node_modules" / "c.py").write_text("NEEDLE\n", encoding="utf-8")
    rt, m = _mount(tmp_path, [("ga-tools", {}), ("tool-grep", {})])
    assert rt.handles["tool-grep"].state == "active"
    assert "grep" in rt.ctx.get("ga.tools").names()

    h = m.GenericAgentHandler()
    h.cwd = str(proj)
    out = h.do_grep({"pattern": "NEEDLE"}, "")
    assert "1 match(es)" in out.data and "a.py:2: NEEDLE = 2" in out.data
    out = h.do_grep({"pattern": "needle", "ignore_case": True, "glob": "*.txt"}, "")
    assert "b.txt:1: needle here" in out.data and "a.py" not in out.data
    assert "[Error]" in h.do_grep({"pattern": "("}, "").data
    assert "[Error]" in h.do_grep({"pattern": "x", "path": "nope"}, "").data

    rt.dispose()
    assert not hasattr(m.GenericAgentHandler, "do_grep")
    assert "grep" not in [t["function"]["name"] for t in m.TOOLS_SCHEMA]
