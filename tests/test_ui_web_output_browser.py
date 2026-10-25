"""Optional real-browser regression: uv run --extra dev --with playwright pytest tests/test_ui_web_output_browser.py.

Install Chromium once with `uv run --with playwright playwright install chromium`.
Set GAH_OUTPUT_ARTIFACTS to retain page screenshots outside the repository.
No live model, user configuration or fixed server port is used.
"""
import os
from pathlib import Path
import threading

import pytest

pw = pytest.importorskip("playwright.sync_api")

from tests.test_frontend import PLUGINS, _mount_with


CODE = 'print("<safe> & readable")\n'
BODY = (
    "## \u5b8c\u6210\u9a8c\u8bc1\n\n"
    "\u6b63\u6587\u652f\u6301 **\u52a0\u7c97**\u3001*\u659c\u4f53* \u548c `inline code`\u3002\n\n"
    "> \u4fdd\u6301\u6e05\u6670\u7684\u4fe1\u606f\u5c42\u7ea7\uff0c\u6267\u884c\u8fc7\u7a0b\u6309\u9700\u5c55\u5f00\u3002\n\n"
    "- [x] \u5b89\u5168\u6e32\u67d3\n- [ ] \u771f\u673a\u9a8c\u6536\n\n"
    "| \u9879\u76ee | \u72b6\u6001 | \u8bf4\u660e |\n| --- | --- | --- |\n"
    "| Markdown | OK | " + "long-value-" * 24 + " |\n\n"
    "```python\n" + CODE + "```\n\n"
    "[safe](https://example.test/docs) [bad](javascript:alert%281%29)\n\n"
    '<img src=x onerror="window.__outputXSS=1"><script>window.__outputXSS=1</script>\n\n'
    "![blocked](data:image/svg+xml;base64,PHN2Zz4=)\n\n"
    "\u5b8c\u6210\u3002"
)
PREFIX = "## Streaming\n\n**partial** reply"


class OutputAgent:
    def __init__(self, ctx):
        self.ctx = ctx
        self.next_turn = threading.Event()
        self.finish = threading.Event()

    def run(self, task, timeout=None):
        e = self.ctx.emit
        e("turn.start", {"turn": 1})
        e("assistant.text", {"turn": 1, "summary": "\u68c0\u67e5\u8f93\u51fa", "reply": "**Inspect** local output."})
        e("tool.call", {"turn": 1, "id": "1.0", "name": "code_run", "args": {"script": CODE}})
        if not self.next_turn.wait(20):
            raise RuntimeError("browser did not release tool")
        e("tool.result", {"turn": 1, "id": "1.0", "name": "code_run", "ok": True,
                          "data": {"stdout": "<safe> & readable"}, "seconds": 0.25})
        e("turn.end", {"turn": 1})
        e("turn.start", {"turn": 2})
        e("assistant.text", {"turn": 2, "summary": "", "reply": PREFIX})
        if not self.finish.wait(20):
            raise RuntimeError("browser did not release final reply")
        e("assistant.text", {"turn": 2, "summary": "", "reply": BODY})
        e("usage.total", {"calls": 2, "input": 1234, "cache_read": 1000, "cache_write": 0, "output": 234})
        return BODY

    def abort(self):
        self.next_turn.set()
        self.finish.set()


@pytest.fixture
def output_app(tmp_path):
    rt = _mount_with(tmp_path, OutputAgent, "ui-web",
                     {"port": 0, "open_browser": False, "log": lambda *args: None})
    fe = rt.ctx.get("frontend")
    theme = PLUGINS / "web-theme"
    fe.web.register("web-theme", head=theme / "head.js", style=theme / "client.css", script=theme / "client.js")
    offs = fe._subscribe()
    base = fe.start()
    try:
        yield fe, rt.ctx.get("agent"), base
    finally:
        rt.ctx.get("agent").abort()
        for off in offs:
            off()
        rt.dispose()


@pytest.fixture
def browser():
    with pw.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            yield browser
        finally:
            browser.close()


def seeded_messages():
    return [
        {"role": "user", "status": "done", "text": "\u8bf7\u68c0\u67e5\u5e76\u5c55\u793a\u7ed3\u679c\u3002"},
        {"role": "assistant", "status": "done", "text": "", "turns": [
            {"turn": 1, "summary": "\u68c0\u67e5\u8f93\u51fa\u683c\u5f0f", "status": "done", "reply": "\u5df2\u8bfb\u53d6 **\u672c\u5730\u6570\u636e**\u3002", "tools": [
                {"id": "1.0", "name": "code_run", "args": {"script": CODE}, "data": "<safe> & readable\n" + "x" * 200,
                 "status": "done", "ok": True, "seconds": 0.25}],
             "usage": {"input": 12345, "cache_read": 10000, "cache_write": 0, "output": 456}},
            {"turn": 2, "summary": "", "status": "done", "reply": BODY, "tools": []}],
         "usage": {"calls": 2, "input": 1234, "cache_read": 1000, "output": 234}},
    ]


def shot(page, name):
    target = os.environ.get("GAH_OUTPUT_ARTIFACTS")
    if target:
        path = Path(target)
        path.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(path / (name + ".png")))


def assert_layout(page):
    dims = page.evaluate("""() => {
        const root = document.documentElement, scroll = document.getElementById('scroll');
        return {root: root.scrollWidth - root.clientWidth, thread: scroll.scrollWidth - scroll.clientWidth,
                visible: document.querySelector('.msg.assistant').getBoundingClientRect().width};
    }""")
    assert dims["root"] <= 1 and dims["thread"] <= 1 and dims["visible"] > 200, dims


@pytest.mark.parametrize("width", [1280, 390])
@pytest.mark.parametrize("running", [False, True])
def test_disclosure_chevrons_trail_content(output_app, browser, width, running):
    fe, _, base = output_app
    fe.messages = seeded_messages()
    if running:
        message = fe.messages[-1]
        message["status"] = "running"
        message["turns"] = message["turns"][:1]
        message["turns"][0]["tools"][0]["status"] = "running"
    page = browser.new_page(locale="zh-CN", viewport={"width": width, "height": 844})
    page.goto(base)
    page.wait_for_selector(".steps > summary")
    for selector in (".steps", ".step", ".tool"):
        summary = page.locator(selector + " > summary")
        assert summary.evaluate("""s => {
            const arrow = s.querySelector('.chev'), r = arrow.getBoundingClientRect();
            const content = [...s.children].filter(n => n !== arrow);
            const edge = s.getBoundingClientRect().right - parseFloat(getComputedStyle(s).paddingRight);
            return s.lastElementChild === arrow && Math.abs(r.right - edge) < 1
                && content.every(n => n.getBoundingClientRect().right <= r.left);
        }""")
        was_open = page.locator(selector).evaluate("d => d.open")
        summary.press("Enter")
        assert page.locator(selector).evaluate("d => d.open") is not was_open
        summary.press("Space")
        assert page.locator(selector).evaluate("d => d.open") is was_open
        if not was_open:
            summary.click()
        assert page.locator(selector).evaluate("d => d.open")
    assert_layout(page)
    page.evaluate("document.getElementById('scroll').scrollTop=0")
    shot(page, f"{width}-trailing-{'running' if running else 'done'}")
    page.close()


@pytest.mark.parametrize("width", [1280, 390])
@pytest.mark.parametrize("locale", ["zh-CN", "en-US"])
def test_admin_style_tool_receipts(output_app, browser, width, locale):
    fe, _, base = output_app
    fe.messages = seeded_messages()
    tools = [
        {"name": "functions.web_execute_js", "args": {"script": "document.title"}},
        {"name": "file_read", "args": {"path": "C:/project/ui/index.html", "start": 176, "count": 39}},
        {"name": "code_run", "args": {"type": "powershell", "script": "Get-Date"}, "status": "running"},
        {"name": "file_patch", "args": {"path": "C:/project/ui/output.css"}, "ok": False},
        {"name": "file_write", "args": {"path": "C:/project/ui/output.js"}},
        {"name": "ask_user", "args": {"question": "<img src=x onerror=window.__receiptXSS=1>"}},
        {"name": "custom_" + "tool_" * 30, "args": {"query": "target-" * 100}},
    ]
    fe.messages[-1]["turns"][0]["tools"] = [
        {"id": f"1.{i}", "status": "done", "ok": True, "seconds": 0.25, "data": "<safe> & readable", **tool}
        for i, tool in enumerate(tools)
    ]
    page = browser.new_page(locale=locale, viewport={"width": width, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base)
    page.locator(".steps > summary").click()
    page.locator(".step > summary").click()
    rows = page.locator(".tool > summary")
    assert rows.count() == 7
    expected = (["\u6d4f\u89c8", "\u8bfb\u53d6", "\u6267\u884c", "\u7f16\u8f91", "\u5199\u5165", "\u8be2\u95ee", "\u5de5\u5177"]
                if locale == "zh-CN" else ["Browse", "Read", "Run", "Edit", "Write", "Ask", "Tool"])
    assert page.locator(".tool .tkind").all_text_contents() == expected
    assert rows.nth(0).locator(".tname").inner_text() == "web_execute_js"
    assert rows.nth(0).locator(".targ").inner_text() == "JavaScript"
    assert rows.nth(1).locator(".targ").inner_text() == "index.html \u00b7 L176\u2013214"
    assert rows.nth(1).locator(".targ").get_attribute("title") == "C:/project/ui/index.html \u00b7 L176\u2013214"
    assert rows.nth(2).locator(".targ").inner_text() == "PowerShell"
    assert rows.nth(2).locator(".tst").inner_text() == ("\u6267\u884c\u4e2d" if locale == "zh-CN" else "Running")
    assert rows.nth(3).locator(".tst").inner_text() == ("\u5931\u8d25" if locale == "zh-CN" else "Failed")
    assert page.locator('.tool[data-state="ok"] .tst').count() == 0
    assert page.locator(".tool img, .tool script").count() == 0
    assert not page.evaluate("window.__receiptXSS || false")
    assert page.locator(".tool-body:visible").count() == 0
    for theme in ["light", "dark", "warm"]:
        page.evaluate("v => document.documentElement.dataset.theme=v", theme)
        assert_layout(page)
        assert rows.evaluate_all("""nodes => nodes.every(s => {
            const c = s.querySelector('.chev'), r = c.getBoundingClientRect();
            const style = getComputedStyle(s.parentElement);
            return s.lastElementChild === c && style.borderTopWidth === '0px'
                && style.backgroundColor === 'rgba(0, 0, 0, 0)'
                && s.getBoundingClientRect().height <= 36
                && Math.abs(s.getBoundingClientRect().right - r.right) < 1
                && [...s.children].filter(n => n !== c).every(n => n.getBoundingClientRect().right <= r.left);
        })""")
        page.evaluate("document.getElementById('scroll').scrollTop=0")
        shot(page, f"{width}-{locale}-{theme}-receipts")
    rows.nth(1).press("Enter")
    assert page.locator(".tool").nth(1).evaluate("d => d.open")
    assert "C:/project/ui/index.html" in page.locator(".tool").nth(1).locator("pre").first.inner_text()
    assert page.locator(".tool").nth(1).locator("pre").last.inner_text() == "<safe> & readable"
    assert "0.3s" in page.locator(".tool").nth(1).locator(".tool-meta").inner_text()
    rows.nth(1).press("Space")
    assert not page.locator(".tool").nth(1).evaluate("d => d.open")
    assert not errors, errors
    page.close()


def test_tool_receipt_summary_handles_argument_shapes(output_app, browser):
    _, _, base = output_app
    page = browser.new_page(locale="en-US")
    page.goto(base)
    cases = [
        ("file_read", {"path": "C:\\ui\\index.html", "start": 3, "count": 1}, "Read", "index.html \u00b7 L3"),
        ("file_read", {"path": "/tmp/index.html", "start": 1}, "Read", "index.html \u00b7 L1\u2013200"),
        ("file_read", {"path": "/tmp/index.html", "start": "bad"}, "Read", "index.html"),
        ("functions.file_patch", '{"path":"/tmp/output.css"}', "Edit", "output.css"),
        ("code_run", {"script": "print('not in the header')"}, "Run", "Python"),
        ("web_scan", {"tabs_only": True}, "Browse", "Tabs"),
        ("web_scan", {}, "Browse", "Page content"),
        ("unknown", "not json", "Tool", ""),
        ("unknown", [], "Tool", ""),
        ("unknown", None, "Tool", ""),
        ("unknown", {"path": {"nested": "data"}}, "Tool", ""),
    ]
    for name, args, kind, target in cases:
        receipt = page.evaluate("([name,args]) => GAHOutput.toolSummary(name,args)", [name, args])
        assert (receipt["kind"], receipt["target"]) == (kind, target)
    page.close()


def test_markdown_safety_copy_and_themes(output_app, browser):
    fe, _, base = output_app
    fe.messages = seeded_messages()
    context = browser.new_context(locale="zh-CN", permissions=["clipboard-read", "clipboard-write"])
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base)
    page.wait_for_selector(".body.md h2")
    assert page.locator(".body.md strong").inner_text() == "\u52a0\u7c97"
    assert page.locator(".body.md .md-table table").count() == 1
    assert page.locator(".body.md .md-code code").inner_text() == CODE
    assert page.locator(".body.md script, .body.md img, .body.md [onerror]").count() == 0
    assert not page.evaluate("window.__outputXSS || false")
    assert page.locator('.body.md a[href^="javascript:"]').count() == 0
    assert page.locator('.body.md a[href="https://example.test/docs"]').get_attribute("rel") == "noopener noreferrer"
    assert page.locator('.body.md input:not([disabled])').count() == 0
    chip = page.locator(".step > summary .tok")
    assert chip.count() == 1 and chip.text_content() == "\u219112k \u2193456"
    assert "12,345" in chip.get_attribute("title") and "10,000" in chip.get_attribute("title")
    page.locator(".md-code .output-copy").click()
    page.locator(".md-code .output-copy.copied").wait_for()
    # Windows' system clipboard converts LF to CRLF; the payload is unchanged.
    assert page.evaluate("navigator.clipboard.readText()").replace("\r\n", "\n") == CODE
    page.locator(".message-actions .output-copy").click()
    page.locator(".message-actions .output-copy.copied").wait_for()
    assert page.evaluate("navigator.clipboard.readText()").replace("\r\n", "\n") == BODY
    palette = set()
    for width in (1280, 390):
        page.set_viewport_size({"width": width, "height": 900 if width == 1280 else 844})
        for theme in ("light", "dark", "warm"):
            page.select_option("#theme", theme)
            assert page.locator("html").get_attribute("data-theme") == theme
            palette.add(page.evaluate("getComputedStyle(document.body).backgroundColor"))
            assert_layout(page)
            page.evaluate("document.getElementById('scroll').scrollTop=0")
            shot(page, f"{width}-{theme}-reply")
            page.locator(".steps > summary").click()
            page.locator(".step > summary").click()
            page.locator(".tool > summary").click()
            assert page.locator(".tool[open]").count() == 1
            assert page.locator(".tool-body script").count() == 0
            assert_layout(page)
            page.evaluate("document.getElementById('scroll').scrollTop=0")
            shot(page, f"{width}-{theme}-process")
            page.locator(".tool > summary").click()
            page.locator(".step > summary").click()
            page.locator(".steps > summary").click()
    assert len(palette) == 3, palette
    assert not errors, errors
    context.close()


def test_streaming_keeps_disclosure_and_final_markdown(output_app, browser):
    fe, agent, base = output_app
    context = browser.new_context(locale="zh-CN")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base)
    page.wait_for_selector(".empty")
    shot(page, "empty")
    page.locator("#input").fill("stream")
    page.locator("#send").click()
    page.wait_for_selector(".tool .tst.run")
    assert page.locator(".steps[open] .step[open]").count() == 1
    page.locator(".tool > summary").click()
    page.locator(".step > summary").click()
    page.locator(".steps > summary").click()
    agent.next_turn.set()
    page.wait_for_function("document.querySelector('.body.md strong')?.textContent === 'partial'")
    assert page.locator(".steps[open]").count() == 0
    page.locator(".steps > summary").click()
    assert page.locator(".step[open]").count() == 0
    page.locator(".step > summary").click()
    assert page.locator(".tool[open]").count() == 1
    assert page.locator('.tool[data-state="ok"]').count() == 1
    assert page.locator(".tool .tool-meta.ok").count() == 1
    assert page.locator(".tool > summary .tst").count() == 0
    agent.finish.set()
    page.wait_for_selector(".message-actions .output-copy")
    assert page.locator(".body.md h2").inner_text() == "\u5b8c\u6210\u9a8c\u8bc1"
    assert page.locator(".body.md .md-code code").inner_text() == CODE
    assert page.locator(".body.cursor").count() == 0
    assert not fe.snapshot()["running"]
    page.reload()
    page.wait_for_selector(".body.md h2")
    assert page.locator(".body.md .md-code code").inner_text() == CODE
    assert page.locator(".steps[open]").count() == 0
    assert not errors, errors
    context.close()


def test_parser_load_failure_is_plain_text(output_app, browser):
    fe, _, base = output_app
    fe.messages = seeded_messages()
    page = browser.new_page(locale="zh-CN")
    page.route("**/marked.umd.js", lambda route: route.abort())
    page.goto(base)
    page.wait_for_selector(".body.md-plain")
    assert page.locator(".body.md-plain").inner_text() == BODY
    assert page.locator(".body script, .body img").count() == 0
    page.close()
