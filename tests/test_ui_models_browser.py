"""Provider-first model dialog, using isolated synthetic configuration only.

Run with the optional Playwright dependency and Chromium installed.
GAH_OUTPUT_ARTIFACTS retains desktop/mobile screenshots outside the repository.
"""
import pytest

from tests.test_frontend import PLUGINS
from tests.test_models import make_models
from tests.test_ui_web import _start
from tests.test_ui_web_output_browser import browser, pw, shot


@pytest.fixture
def models_app(tmp_path):
    store = make_models(tmp_path)

    def change(action, **data):
        return store.change(dict(action=action, revision=store.config()["revision"], **data))

    for pid in ("acme", "beta", "empty"):
        change("provider_save", id=pid, values={"name": pid.title(), "protocol": "oai",
               "apibase": "https://" + pid + ".invalid/v1", "apikey": "synthetic-" + pid})
    for pid in ("acme", "beta"):
        change("save", key="native_oai_config_" + pid,
               values={"name": pid.title() + " model", "model": pid + "-1", "provider": pid})
    # Same endpoint is only a visual group; credentials remain independent.
    for protocol in ("oai", "claude"):
        change("save", key="native_" + protocol + "_config_legacy",
               values={"model": protocol + "-legacy", "apibase": "https://example.invalid/v1",
                       "apikey": "synthetic-" + protocol})
    rt, fe, off, base = _start(tmp_path)
    fe.models = store
    for name in ("web-models", "web-theme"):
        folder = PLUGINS / name
        fe.web.register(name, script=folder / "client.js", style=folder / "client.css")
    try:
        yield store, base
    finally:
        off()
        rt.dispose()


def open_models(page, base):
    page.goto(base)
    # Sidebar is collapsed on phones; open the same plugin trigger directly.
    page.locator('.side-item[data-gah-plugin="web-models"]').evaluate("b => b.click()")
    dialog = page.locator(".gah-model-dialog")
    pw.expect(dialog.locator(".model-layout")).to_be_visible()
    return dialog


def button(root, text):
    return root.get_by_role("button", name=text, exact=True)


def section(dialog, pid):
    return dialog.locator('[data-section="provider:' + pid + '"]')


def model_form(dialog):
    return dialog.locator(".model-editor form")


def assert_no_overflow(dialog):
    assert dialog.evaluate("d => d.scrollWidth <= d.clientWidth + 1")
    assert dialog.locator(".model-section-body").evaluate("d => d.scrollWidth <= d.clientWidth + 1")


def test_provider_sections_and_crud(browser, models_app):
    store, base = models_app
    page = browser.new_page(viewport={"width": 1280, "height": 1000})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    try:
        dialog = open_models(page, base)
        form = model_form(dialog)
        pw.expect(dialog.locator(".model-section-item")).to_have_count(5)
        pw.expect(section(dialog, "acme")).to_have_attribute("aria-current", "true")
        pw.expect(dialog.locator(".model-list-item")).to_have_text(["Acme modelacme-1"])
        section(dialog, "beta").click()
        pw.expect(form.get_by_label("\u6a21\u578b ID", exact=True)).to_have_value("beta-1")
        pw.expect(dialog.locator(".model-list-item")).to_have_count(1)
        button(dialog, "\u65b0\u589e\u6a21\u578b").click()
        pw.expect(form.get_by_label("\u6240\u5c5e\u670d\u52a1\u5546")).to_have_value("beta")
        pw.expect(form.get_by_label("API Key")).to_be_hidden()
        form.get_by_label("\u663e\u793a\u540d\u79f0", exact=True).fill("Beta added")
        form.get_by_label("\u6a21\u578b ID", exact=True).fill("beta-2")
        added_key = form.get_by_label("\u914d\u7f6e\u6807\u8bc6").input_value()
        button(dialog, "\u4fdd\u5b58\u5e76\u751f\u6548").click()
        pw.expect(dialog.locator(".model-list-item")).to_have_count(2)
        pw.expect(form.get_by_label("\u914d\u7f6e\u6807\u8bc6")).to_have_value(added_key)
        assert next(e for e in store.config()["entries"] if e["key"] == added_key)["provider"] == "beta"
        # Moving a model selects its new section rather than a stale old section.
        form.get_by_label("\u6240\u5c5e\u670d\u52a1\u5546").select_option("acme")
        button(dialog, "\u4fdd\u5b58\u5e76\u751f\u6548").click()
        pw.expect(section(dialog, "acme")).to_have_attribute("aria-current", "true")
        pw.expect(form.get_by_label("\u6a21\u578b ID", exact=True)).to_have_value("beta-2")
        assert next(e for e in store.config()["entries"] if e["key"] == added_key)["provider"] == "acme"
        assert_no_overflow(dialog)
        shot(page, "models-desktop")
        button(dialog, "\u670d\u52a1\u5546\u8bbe\u7f6e").click()
        provider = dialog.locator(".model-section-body > form")
        pw.expect(provider.get_by_label("\u670d\u52a1\u5546\u6807\u8bc6")).to_have_value("acme")
        pw.expect(provider.get_by_label("API Key")).to_have_value("")
        provider.get_by_label("\u663e\u793a\u540d\u79f0", exact=True).fill("Acme renamed")
        button(dialog, "\u4fdd\u5b58\u670d\u52a1\u5546").click()
        pw.expect(section(dialog, "acme")).to_contain_text("Acme renamed")
        pw.expect(section(dialog, "acme")).to_have_attribute("aria-current", "true")
        section(dialog, "empty").click()
        pw.expect(dialog.locator(".model-empty")).to_be_visible()
        pw.expect(dialog.locator(".model-editor")).to_be_hidden()
        button(dialog, "\u65b0\u589e\u670d\u52a1\u5546").click()
        provider.get_by_label("\u670d\u52a1\u5546\u6807\u8bc6").fill("new-provider")
        provider.get_by_label("API Base URL").fill("https://new.invalid/v1")
        provider.get_by_label("API Key").fill("synthetic-new")
        button(dialog, "\u4fdd\u5b58\u670d\u52a1\u5546").click()
        pw.expect(section(dialog, "new-provider")).to_have_attribute("aria-current", "true")
        pw.expect(dialog.locator(".model-editor")).to_be_hidden()
        button(dialog, "\u65b0\u589e\u6a21\u578b").click()
        form.get_by_label("\u6a21\u578b ID", exact=True).fill("new-model")
        button(dialog, "\u4fdd\u5b58\u5e76\u751f\u6548").click()
        pw.expect(dialog.locator(".model-list-item")).to_have_count(1)
        button(dialog, "\u5220\u9664\u914d\u7f6e").click()
        pw.expect(dialog.locator(".model-empty")).to_be_visible()
        button(dialog, "\u670d\u52a1\u5546\u8bbe\u7f6e").click()
        button(dialog, "\u5220\u9664\u670d\u52a1\u5546").click()
        pw.expect(section(dialog, "new-provider")).to_have_count(0)
        legacy = dialog.locator('[data-section^="legacy:"]')
        pw.expect(legacy).to_have_count(2)
        legacy.first.click()
        pw.expect(dialog.locator(".model-list-item")).to_have_count(2)
        pw.expect(button(dialog, "\u670d\u52a1\u5546\u8bbe\u7f6e")).to_be_hidden()
        button(dialog, "\u65b0\u589e\u6a21\u578b").click()
        pw.expect(form.get_by_label("API Base URL")).to_have_value("https://example.invalid/v1")
        pw.expect(form.get_by_label("API Key")).to_have_value("")
        assert form.get_by_label("API Key").evaluate("e => e.required")
        # Navigation must not silently bind or rewrite old models.
        assert next(e for e in store.config()["entries"] if e["key"] == "native_oai_config_one")["provider"] is None
        legacy.last.click()
        pw.expect(dialog.locator(".model-list-item")).to_have_count(1)
        button(dialog, "\u65b0\u589e\u6a21\u578b").click()
        assert "claude_config" in form.get_by_label("\u914d\u7f6e\u6807\u8bc6").input_value()
        page.set_viewport_size({"width": 390, "height": 844})
        section(dialog, "acme").click()
        assert_no_overflow(dialog)
        shot(page, "models-mobile")
        save = button(dialog, "\u4fdd\u5b58\u5e76\u751f\u6548")
        save.scroll_into_view_if_needed()
        pw.expect(save).to_be_in_viewport()
        pw.expect(save).to_be_enabled()
        shot(page, "models-mobile-bottom")
        assert not errors
    finally:
        page.close()


def test_loading_errors_readonly_and_busy(browser, models_app):
    store, base = models_app
    original = store.source.file.read_bytes()
    page = browser.new_page(viewport={"width": 1280, "height": 1000})
    pending = []
    try:
        page.route("**/api/models/config", lambda route: pending.append(route))
        page.goto(base)
        trigger = page.locator('.side-item[data-gah-plugin="web-models"]')
        trigger.click()
        dialog = page.locator(".gah-model-dialog")
        pw.expect(dialog.get_by_text("\u6b63\u5728\u52a0\u8f7d\u6a21\u578b\u914d\u7f6e\u2026", exact=True)).to_be_visible()
        pw.expect(button(dialog, "\u5173\u95ed")).to_be_disabled()
        pw.expect(dialog.locator(".model-layout")).to_be_hidden()
        assert len(pending) == 1
        pending.pop().fulfill(status=500, json={"error": "synthetic load failure"})
        pw.expect(dialog.locator(".gah-error").first).to_contain_text("synthetic load failure")
        button(dialog, "\u5173\u95ed").click()
        page.unroute("**/api/models/config")
        readonly = store.config() | {"writable": False, "reason_code": "inline"}
        page.route("**/api/models/config", lambda route: route.fulfill(json=readonly))
        trigger.click()
        pw.expect(dialog.locator(".model-layout")).to_be_visible()
        pw.expect(button(dialog, "\u65b0\u589e\u6a21\u578b")).to_be_disabled()
        pw.expect(button(dialog, "\u65b0\u589e\u670d\u52a1\u5546")).to_be_disabled()
        section(dialog, "beta").click()
        pw.expect(model_form(dialog).get_by_label("\u6a21\u578b ID", exact=True)).to_have_value("beta-1")
        pw.expect(button(dialog, "\u4fdd\u5b58\u5e76\u751f\u6548")).to_be_disabled()
        button(dialog, "\u670d\u52a1\u5546\u8bbe\u7f6e").click()
        pw.expect(button(dialog, "\u4fdd\u5b58\u670d\u52a1\u5546")).to_be_disabled()
        button(dialog, "\u5173\u95ed").click()
        page.unroute("**/api/models/config")
        trigger.click()
        pw.expect(button(dialog, "\u4fdd\u5b58\u5e76\u751f\u6548")).to_be_enabled()
        page.route("**/api/models/config", lambda route: pending.append(route))
        button(dialog, "\u4fdd\u5b58\u5e76\u751f\u6548").click()
        pw.expect(section(dialog, "acme")).to_be_disabled()
        pw.expect(button(dialog, "\u5173\u95ed")).to_be_disabled()
        assert len(pending) == 1
        pending.pop().fulfill(status=409, json={"error": "synthetic save conflict"})
        pw.expect(dialog.locator(".gah-error").first).to_contain_text("synthetic save conflict")
        pw.expect(button(dialog, "\u4fdd\u5b58\u5e76\u751f\u6548")).to_be_enabled()
        pw.expect(section(dialog, "beta")).to_have_attribute("aria-current", "true")
        assert store.source.file.read_bytes() == original
    finally:
        page.close()
