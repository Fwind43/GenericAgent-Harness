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
                 "status": "done", "ok": True, "seconds": 0.25}]},
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
    assert page.locator(".tool .tst.ok").count() == 1
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
