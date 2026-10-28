"""Card-grid plugin manager on an isolated server with a synthetic catalog.

Run with the optional Playwright dependency and Chromium installed.
GAH_OUTPUT_ARTIFACTS retains desktop/mobile screenshots outside the repository.
"""
import json

import pytest

from tests.test_frontend import PLUGINS
from tests.test_plugin_manager import make_manager
from tests.test_ui_web import _start
from tests.test_ui_web_output_browser import browser, pw, shot


@pytest.fixture
def plugins_app(tmp_path):
    manager_rt, manager = make_manager(tmp_path)
    rt, fe, off, base = _start(tmp_path)
    fe.plugins = manager
    for name in ("web-plugins", "web-theme"):
        folder = PLUGINS / name
        fe.web.register(name, script=folder / "client.js", style=folder / "client.css")
    try:
        yield manager, base
    finally:
        off()
        rt.dispose()
        manager_rt.dispose()


def open_plugins(page, base):
    page.goto(base)
    page.locator('[data-gah-plugin="web-plugins"] .side-item').evaluate("b => b.click()")
    dialog = page.locator(".gah-plugin-dialog")
    pw.expect(dialog.locator(".plugin-card").first).to_be_visible()
    return dialog


def card(dialog, name):
    return dialog.locator('.plugin-card[data-plugin="' + name + '"]')


def no_overflow(dialog):
    return dialog.evaluate("d => d.scrollWidth <= d.clientWidth + 1")


def test_cards_filter_detail_and_save(browser, plugins_app):
    manager, base = plugins_app
    names = [i["name"] for i in manager.catalog()["items"]]
    page = browser.new_page(locale="zh-CN", viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    dialog = open_plugins(page, base)
    pw.expect(dialog.locator(".plugin-card")).to_have_count(len(names))
    # Cards sit side by side in a grid, not a single list column.
    tops = dialog.locator('.plugin-group[data-category="ui"] .plugin-card').evaluate_all("cs => cs.slice(0, 3).map(c => c.getBoundingClientRect().top)")
    # Group headings carry the category; cards and details need no duplicate avatars.
    cats = [i["category"] for i in manager.catalog()["items"]]
    order = [c for c in ("core", "extension", "observe", "service", "ui", "other") if c in cats]
    assert dialog.locator(".plugin-group").evaluate_all("gs => gs.map(g => g.dataset.category)") == order
    pw.expect(dialog.locator(".plugin-avatar")).to_have_count(0)
    assert len(set(round(t) for t in tops)) == 1
    assert no_overflow(dialog)
    pw.expect(card(dialog, "ga-core").locator(".plugin-tag")).to_contain_text(["\u53d7\u4fdd\u62a4"])
    assert "DO-NOT-EXPOSE" not in dialog.inner_text()
    # Full names stay readable, and the last card is reachable by scrolling.
    assert dialog.locator(".plugin-name").evaluate_all("ns => ns.every(n => n.scrollWidth <= n.clientWidth + 1)")
    last = dialog.locator(".plugin-card").last
    last.scroll_into_view_if_needed()
    pw.expect(last).to_be_in_viewport()
    dialog.locator(".plugin-card").first.scroll_into_view_if_needed()
    shot(page, "plugins_cards_1280")

    dialog.locator(".plugin-search").fill("dem")
    pw.expect(dialog.locator(".plugin-card")).to_have_count(1)
    dialog.locator(".plugin-search").fill("")
    off = dialog.locator('.plugin-filter[data-filter="off"]')
    off.click()
    pw.expect(off).to_have_attribute("aria-selected", "true")
    expected_off = sum(i["state"] in ("disabled", "removed") for i in manager.catalog()["items"])
    pw.expect(dialog.locator(".plugin-card")).to_have_count(expected_off)
    dialog.locator('.plugin-filter[data-filter="all"]').click()

    card(dialog, "demo").click()
    detail = dialog.locator(".plugin-detail")
    pw.expect(detail).to_be_visible()
    pw.expect(dialog.locator(".plugin-catalog")).to_be_hidden()
    pw.expect(detail.locator(".plugin-title")).to_have_text("demo")
    limit = detail.locator('[data-plugin-field="limit"]')
    pw.expect(limit).to_have_value("10")
    assert detail.locator('[data-plugin-field="secret"]').count() == 0
    shot(page, "plugins_detail_1280")
    mode = detail.locator('select[data-plugin-field="mode"]')
    pw.expect(mode).to_have_value("fast")
    assert mode.locator("option").all_inner_texts() == ["\u5feb\u901f", "\u7a33\u59a5"]
    note = detail.locator('textarea[data-plugin-field="note"]')
    pw.expect(note).to_be_visible()
    limit.fill("42")
    mode.select_option("safe")
    note.fill("line1\nline2")
    detail.locator('button[type="submit"]').click()
    pw.expect(detail.locator(".plugin-tag[data-tag='pending']").first).to_be_visible()
    saved = next(i for i in manager.catalog()["items"] if i["name"] == "demo")
    assert saved["config"]["limit"] == 42 and saved["restart_required"] and saved["overridden"]
    assert saved["config"]["mode"] == "safe" and saved["config"]["note"] == "line1\nline2"
    assert "DO-NOT-EXPOSE" not in json.dumps(manager.catalog())

    detail.locator(".plugin-reset").click()
    pw.expect(detail.locator(".plugin-reset")).to_be_disabled()
    assert next(i for i in manager.catalog()["items"] if i["name"] == "demo")["config"]["limit"] == 10

    # Escape returns to the grid first, then closes the dialog.
    page.keyboard.press("Escape")
    pw.expect(dialog.locator(".plugin-catalog")).to_be_visible()
    pw.expect(card(dialog, "demo")).to_be_focused()
    card(dialog, "ga-core").click()
    pw.expect(detail.locator('button[type="submit"]')).to_be_disabled()
    card_fields = detail.locator("[data-plugin-field]")
    assert card_fields.evaluate_all("fs => fs.every(f => f.disabled)")
    detail.locator(".plugin-back").click()
    pw.expect(dialog.locator(".plugin-catalog")).to_be_visible()
    assert errors == []


def test_mobile_cards_single_column(browser, plugins_app):
    _, base = plugins_app
    page = browser.new_page(locale="zh-CN", viewport={"width": 390, "height": 844})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    dialog = open_plugins(page, base)
    lefts = dialog.locator(".plugin-card").evaluate_all("cs => cs.slice(0, 3).map(c => c.getBoundingClientRect().left)")
    assert len(set(round(x) for x in lefts)) == 1
    assert no_overflow(dialog)
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    shot(page, "plugins_cards_390")
    card(dialog, "demo").click()
    save = dialog.locator('.plugin-detail button[type="submit"]')
    save.scroll_into_view_if_needed()
    pw.expect(save).to_be_in_viewport()
    assert no_overflow(dialog)
    shot(page, "plugins_detail_390")
    assert errors == []


def test_language_follows_browser_and_toggle(browser, plugins_app):
    _, base = plugins_app
    page = browser.new_page(locale="en-US", viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    dialog = open_plugins(page, base)
    assert page.evaluate("document.documentElement.lang") == "en"
    pw.expect(card(dialog, "ga-core").locator(".plugin-tag")).to_contain_text(["Protected"])
    pw.expect(card(dialog, "ga-core")).to_contain_text("Host an unmodified GenericAgent")
    assert not any("\u4e00" <= ch <= "\u9fff" for ch in dialog.inner_text())
    page.keyboard.press("Escape")
    page.locator("#settingsBtn").click()
    page.locator(".gah-settings-tab", has_text="General").click()
    with page.expect_navigation():
        page.locator('.gah-lang-options [data-lang="zh"]').click()
    assert page.evaluate("GAH_LANG") == "zh"
    dialog = open_plugins(page, base)
    pw.expect(card(dialog, "ga-core")).to_contain_text("\u627f\u8f7d\u672a\u7ecf\u4fee\u6539\u7684 GenericAgent")
    pw.expect(card(dialog, "ga-core").locator(".plugin-tag")).to_contain_text(["\u53d7\u4fdd\u62a4"])
    assert errors == []
