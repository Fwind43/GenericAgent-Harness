"""Search-first model picker and editor, using isolated synthetic configuration only.

Run with the optional Playwright dependency and Chromium installed.
GAH_OUTPUT_ARTIFACTS retains desktop/mobile screenshots outside the repository.
"""
import json

import pytest

from ga_harness.sessions import Sessions
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
    store.agent.history = []
    fe.ctx.provide("ga.agent", store.agent)
    fe.sessions = Sessions(store.agent, tmp_path / "picker-sessions.sqlite3")
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
    # Use the unified settings entry, including when the phone sidebar is collapsed.
    page.locator("#settingsBtn").evaluate("b => b.click()")
    dialog = page.locator(".gah-model-dialog")
    pw.expect(dialog.locator(".model-layout")).to_be_visible()
    return dialog


def button(root, text):
    return root.get_by_role("button", name=text, exact=True)


def provider_filter(dialog):
    return dialog.locator(".model-provider-filter")


def section(dialog, pid):
    return provider_filter(dialog).locator('option[value="provider:' + pid + '"]')


def model_form(dialog):
    return dialog.locator(".model-editor form")


def assert_no_overflow(dialog):
    assert dialog.evaluate("d => d.scrollWidth <= d.clientWidth + 1")
    assert dialog.locator(".model-layout").evaluate("d => d.scrollWidth <= d.clientWidth + 1")


@pytest.mark.parametrize("width,locale", [(1280, "zh-CN"), (390, "zh-CN"), (1280, "en-US")])
def test_searchable_picker_providers_effort_and_session_scope(browser, models_app, width, locale):
    store, base = models_app
    page = browser.new_page(viewport={"width": width, "height": 844}, locale=locale)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    try:
        page.goto(base)
        trigger = page.locator(".gah-model-trigger")
        picker = page.locator(".gah-model-popover")
        pw.expect(trigger).to_be_visible()
        pw.expect(page.locator(".gah-models button")).to_have_count(1)
        pw.expect(page.locator(".gah-models select")).to_have_count(0)
        trigger.click()
        pw.expect(picker).to_be_visible()
        pw.expect(trigger).to_have_attribute("aria-expanded", "true")
        pw.expect(picker.locator(".gah-picker-effort")).to_be_visible()
        pw.expect(picker.locator("[data-effort]")).to_have_count(5)
        catalog = store.catalog()
        groups = {}
        for row in catalog["items"]:
            groups.setdefault(row["provider_id"], []).append(row)
        options = picker.locator(".gah-picker-option")
        search = picker.locator(".gah-picker-search")
        providers = picker.locator(".gah-picker-filter")
        pw.expect(options).to_have_count(len(catalog["items"]))
        pw.expect(providers.locator("option")).to_have_count(len(groups) + 1)
        for pid, rows in groups.items():
            providers.select_option(pid)
            pw.expect(options).to_have_count(len(rows))
            pw.expect(picker.locator('[data-provider="' + pid + '"]')).to_have_count(len(rows))
        providers.select_option("")
        search.fill("BeTa 1")
        pw.expect(options).to_have_count(1)
        pw.expect(options.first).to_contain_text("Beta model")
        search.fill("no-such-model")
        pw.expect(options).to_have_count(0)
        pw.expect(picker.locator(".gah-picker-empty")).to_be_visible()
        search.fill("")
        pw.expect(options).to_have_count(len(catalog["items"]))
        assert picker.evaluate("e => e.scrollWidth <= e.clientWidth + 1")
        bounds = picker.bounding_box()
        assert bounds["x"] >= 0 and bounds["x"] + bounds["width"] <= width
        assert bounds["y"] >= 0 and bounds["y"] + bounds["height"] <= 844
        shot(page, "model-picker-" + str(width) + "-" + locale)
        search.press("ArrowDown")
        pw.expect(options.first).to_be_focused()
        page.keyboard.press("End")
        pw.expect(options.last).to_be_focused()
        page.keyboard.press("Home")
        pw.expect(options.first).to_be_focused()
        page.keyboard.press("Escape")
        pw.expect(picker).to_be_hidden()
        pw.expect(trigger).to_be_focused()
        trigger.click()
        with page.expect_response("**/api/effort") as response:
            picker.locator('[data-effort="high"]').click()
        assert response.value.ok
        pw.expect(picker).to_be_hidden()
        pw.expect(trigger).to_contain_text("High" if locale == "en-US" else "\u9ad8")
        before = page.request.get(base + "api/state").json()
        assert before["effort"]["current"] == "high"
        trigger.click()
        target = next(r for r in catalog["items"] if r["provider_id"] == "provider:beta")
        search.fill("beta")
        with page.expect_response("**/api/models/select") as response:
            search.press("Enter")
        assert response.value.ok
        pw.expect(trigger).to_contain_text("Beta model")
        page.reload()
        pw.expect(trigger).to_contain_text("High" if locale == "en-US" else "\u9ad8")
        state = page.request.get(base + "api/state").json()
        assert state["models"]["current"] == target["id"]
        assert state["effort"]["current"] == "high"
        # The picker changes the current conversation, never the model config.
        assert page.request.post(base + "api/sessions", data={"action": "new"}).ok
        page.reload()
        pw.expect(trigger).to_contain_text("Default" if locale == "en-US" else "\u9ed8\u8ba4")
        assert page.request.post(base + "api/sessions", data={"action": "select", "id": before["session_id"]}).ok
        page.reload()
        pw.expect(trigger).to_contain_text("High" if locale == "en-US" else "\u9ad8")
        assert not errors
    finally:
        page.close()


def test_picker_pending_error_and_busy_states(browser, models_app):
    store, base = models_app
    page = browser.new_page(locale="en-US")
    pending = []
    try:
        page.goto(base)
        trigger = page.locator(".gah-model-trigger")
        picker = page.locator(".gah-model-popover")
        pw.expect(trigger).to_be_enabled()
        original = page.request.get(base + "api/state").json()
        page.route("**/api/effort", lambda route: pending.append(route))
        trigger.click()
        picker.locator('[data-effort="high"]').click()
        pw.expect(trigger).to_be_disabled()
        assert len(pending) == 1
        pending.pop().fulfill(status=409, json={"error": "synthetic effort conflict"})
        pw.expect(trigger).to_be_enabled()
        pw.expect(page.get_by_text("synthetic effort conflict", exact=True)).to_be_visible()
        assert page.request.get(base + "api/state").json()["effort"] == original["effort"]
        page.unroute("**/api/effort")
        busy_state = dict(original, running=True)
        page.route("**/api/state", lambda route: route.fulfill(json=busy_state))
        page.route("**/api/events", lambda route: route.fulfill(
            content_type="text/event-stream",
            body="event: snapshot\ndata: " + json.dumps(busy_state) + "\n\n"))
        page.reload()
        pw.expect(trigger).to_be_visible()
        pw.expect(trigger).to_be_disabled()
        pw.expect(picker).to_be_hidden()
    finally:
        page.close()



def test_search_and_provider_filter_crud(browser, models_app):
    store, base = models_app
    page = browser.new_page(locale="zh-CN", viewport={"width": 1280, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        dialog = open_models(page, base)
        form = model_form(dialog)
        pw.expect(provider_filter(dialog)).to_have_value("")
        count = len(store.config()["entries"])
        pw.expect(dialog.locator(".model-list-item")).to_have_count(count)
        search = dialog.locator(".model-search")
        search.fill("BETA 1")
        pw.expect(dialog.locator(".model-list-item")).to_have_count(1)
        pw.expect(dialog.locator(".model-list-item")).to_contain_text("Beta model")
        search.fill("no-such-model")
        pw.expect(dialog.locator(".model-list-item")).to_have_count(0)
        # Searching only filters the list; it must not discard the selected editor.
        pw.expect(form).to_be_visible()
        search.fill("")
        pw.expect(dialog.locator(".model-list-item")).to_have_count(count)
        dialog.locator(".model-list-item").filter(has_text="Acme model").click()
        name = form.get_by_label("\u663e\u793a\u540d\u79f0", exact=True)
        name.fill("Unsaved name")
        search.fill("acme")
        pw.expect(name).to_have_value("Unsaved name")
        search.fill("")
        left = dialog.locator(".model-list-pane").bounding_box()
        right = dialog.locator(".model-editor").bounding_box()
        assert left["x"] + left["width"] <= right["x"]
        # Filtering to another provider is guarded; cancelling preserves the draft.
        provider_filter(dialog).select_option("provider:beta")
        ask = page.locator(".gah-ask")
        button(ask, "\u7ee7\u7eed\u7f16\u8f91").click()
        pw.expect(name).to_have_value("Unsaved name")
        pw.expect(provider_filter(dialog)).to_have_value("")
        provider_filter(dialog).select_option("provider:beta")
        button(ask, "\u653e\u5f03\u66f4\u6539").click()
        pw.expect(form.get_by_label("\u6a21\u578b ID", exact=True)).to_have_value("beta-1")
        dialog.locator(".model-add").click()
        pw.expect(form.get_by_label("\u670d\u52a1\u5546", exact=True)).to_have_value("beta")
        pw.expect(form.get_by_label("API Key", exact=True)).to_have_count(0)
        form.get_by_label("\u663e\u793a\u540d\u79f0", exact=True).fill("Beta added")
        form.get_by_label("\u6a21\u578b ID", exact=True).fill("beta-2")
        form.locator(".model-advanced summary").click()
        added_key = form.get_by_label("\u914d\u7f6e\u6807\u8bc6").input_value()
        button(form, "\u4fdd\u5b58\u5e76\u751f\u6548").click()
        pw.expect(dialog.locator(".model-list-item")).to_have_count(2)
        assert next(item for item in store.config()["entries"] if item["key"] == added_key)["provider"] == "beta"
        form.get_by_label("\u670d\u52a1\u5546", exact=True).select_option("acme")
        button(form, "\u4fdd\u5b58\u5e76\u751f\u6548").click()
        pw.expect(provider_filter(dialog)).to_have_value("provider:acme")
        pw.expect(form.get_by_label("\u6a21\u578b ID", exact=True)).to_have_value("beta-2")
        assert next(item for item in store.config()["entries"] if item["key"] == added_key)["provider"] == "acme"
        assert_no_overflow(dialog)
        shot(page, "models-desktop")
        # Provider management is a first-class view, also reachable from a model.
        button(form, "\u7f16\u8f91\u670d\u52a1\u5546").click()
        provider = model_form(dialog)
        pw.expect(provider.get_by_label("\u670d\u52a1\u5546\u6807\u8bc6")).to_have_value("acme")
        pw.expect(provider.get_by_label("API Key", exact=True)).to_have_value("")
        provider.get_by_label("\u663e\u793a\u540d\u79f0", exact=True).fill("Acme renamed")
        button(provider, "\u4fdd\u5b58\u5e76\u751f\u6548").click()
        pw.expect(dialog.locator(".model-list-item").filter(has_text="Acme renamed")).to_have_count(1)
        dialog.locator(".model-add").click()
        provider.get_by_label("\u670d\u52a1\u5546\u6807\u8bc6").fill("new-provider")
        provider.get_by_label("API Base URL").fill("https://new.invalid/v1")
        provider.get_by_label("API Key", exact=True).fill("synthetic-new")
        button(provider, "\u4fdd\u5b58\u5e76\u751f\u6548").click()
        pw.expect(provider.get_by_label("\u670d\u52a1\u5546\u6807\u8bc6")).to_have_value("new-provider")
        provider.get_by_role("button", name="\u67e5\u770b\u6a21\u578b").click()
        pw.expect(provider_filter(dialog)).to_have_value("provider:new-provider")
        pw.expect(dialog.locator(".model-list-item")).to_have_count(0)
        dialog.locator(".model-add").click()
        form.get_by_label("\u6a21\u578b ID", exact=True).fill("new-model")
        button(form, "\u4fdd\u5b58\u5e76\u751f\u6548").click()
        pw.expect(dialog.locator(".model-list-item")).to_have_count(1)
        form.locator(".model-delete").click()
        button(page.locator(".gah-ask"), "\u5220\u9664").click()
        pw.expect(dialog.locator(".model-list-item")).to_have_count(0)
        dialog.locator(".model-view-switch button").nth(1).click()
        dialog.locator(".model-search").fill("new-provider")
        dialog.locator(".model-list-item").click()
        provider.locator(".model-delete").click()
        button(page.locator(".gah-ask"), "\u5220\u9664").click()
        pw.expect(dialog.locator(".model-list-item").filter(has_text="new-provider")).to_have_count(0)
        dialog.locator(".model-view-switch button").first.click()
        pw.expect(section(dialog, "new-provider")).to_have_count(0)
        legacy = provider_filter(dialog).locator('option[value^="legacy:"]')
        pw.expect(legacy).to_have_count(2)
        provider_filter(dialog).select_option(legacy.first.get_attribute("value"))
        pw.expect(dialog.locator(".model-list-item")).to_have_count(2)
        dialog.locator(".model-add").click()
        pw.expect(form.get_by_label("\u670d\u52a1\u5546", exact=True)).to_have_value("")
        pw.expect(form.get_by_label("API Base URL")).to_have_value("")
        pw.expect(form.get_by_label("API Key", exact=True)).to_have_value("")
        assert form.get_by_label("API Key", exact=True).evaluate("element => element.required")
        assert next(item for item in store.config()["entries"] if item["key"] == "native_oai_config_one")["provider"] is None
        provider_filter(dialog).select_option(legacy.last.get_attribute("value"))
        dialog.locator(".model-add").click()
        form.locator(".model-advanced summary").click()
        assert "claude_config" in form.get_by_label("\u914d\u7f6e\u6807\u8bc6").input_value()
        assert not errors
    finally:
        page.close()


@pytest.mark.parametrize("width", [1280, 390])
def test_draft_close_reset_and_mobile_drill_in(browser, models_app, width):
    store, base = models_app
    original = store.source.file.read_bytes()
    page = browser.new_page(locale="zh-CN", viewport={"width": width, "height": 844})
    try:
        dialog = open_models(page, base)
        shell = page.locator("#gah-settings")
        dialog.locator(".model-list-item").filter(has_text="Acme model").click()
        form = model_form(dialog)
        name = form.get_by_label("\u663e\u793a\u540d\u79f0", exact=True)
        old_name = name.input_value()
        pw.expect(form.locator(".model-advanced")).not_to_have_attribute("open", "")
        pw.expect(button(form, "\u4fdd\u5b58\u5e76\u751f\u6548")).to_be_disabled()
        name.fill("Unsaved mobile draft")
        pw.expect(button(form, "\u4fdd\u5b58\u5e76\u751f\u6548")).to_be_in_viewport()
        assert_no_overflow(dialog)
        shot(page, "models-mobile" if width == 390 else "models-draft-desktop")
        button(shell, "\u5173\u95ed").click()
        ask = page.locator(".gah-ask")
        button(ask, "\u7ee7\u7eed\u7f16\u8f91").click()
        pw.expect(name).to_have_value("Unsaved mobile draft")
        button(form, "\u64a4\u9500\u66f4\u6539").click()
        button(ask, "\u653e\u5f03\u66f4\u6539").click()
        pw.expect(name).to_have_value(old_name)
        if width == 390:
            pw.expect(dialog.locator(".model-list-pane")).to_be_hidden()
            button(dialog, "\u8fd4\u56de\u5217\u8868").click()
            pw.expect(dialog.locator(".model-list-pane")).to_be_visible()
            pw.expect(dialog.locator(".model-editor")).to_be_hidden()
            dialog.locator(".model-list-item").filter(has_text="Acme model").click()
        name.fill("Discard on close")
        page.keyboard.press("Escape")
        button(ask, "\u653e\u5f03\u66f4\u6539").click()
        pw.expect(shell).to_be_hidden()
        page.locator("#settingsBtn").evaluate("element => element.click()")
        pw.expect(dialog.locator(".model-layout")).to_be_visible()
        button(shell, "\u5173\u95ed").click()
        pw.expect(shell).to_be_hidden()
        pw.expect(ask).to_have_count(0)
        assert store.source.file.read_bytes() == original
    finally:
        page.close()


def test_loading_errors_readonly_and_busy(browser, models_app):
    store, base = models_app
    original = store.source.file.read_bytes()
    page = browser.new_page(locale="zh-CN", viewport={"width": 1280, "height": 1000})
    pending = []
    try:
        page.route("**/api/models/config", lambda route: pending.append(route))
        page.goto(base)
        trigger = page.locator("#settingsBtn")
        trigger.click()
        shell = page.locator("#gah-settings")
        dialog = page.locator(".gah-model-dialog")
        pw.expect(dialog.locator(".model-empty")).to_be_visible()
        pw.expect(button(shell, "\u5173\u95ed")).to_be_disabled()
        pw.expect(dialog.locator(".model-layout")).to_have_count(0)
        assert len(pending) == 1
        pending.pop().fulfill(status=500, json={"error": "synthetic load failure"})
        pw.expect(dialog.locator(".model-error")).to_contain_text("synthetic load failure")
        button(shell, "\u5173\u95ed").click()
        page.unroute("**/api/models/config")
        readonly = store.config() | {"writable": False, "reason_code": "inline"}
        page.route("**/api/models/config", lambda route: route.fulfill(json=readonly))
        trigger.click()
        pw.expect(dialog.locator(".model-layout")).to_be_visible()
        pw.expect(dialog.locator(".model-add")).to_be_disabled()
        provider_filter(dialog).select_option("provider:beta")
        form = model_form(dialog)
        pw.expect(form.get_by_label("\u6a21\u578b ID", exact=True)).to_be_disabled()
        pw.expect(button(form, "\u4fdd\u5b58\u5e76\u751f\u6548")).to_be_disabled()
        dialog.locator(".model-view-switch button").nth(1).click()
        pw.expect(dialog.locator(".model-add")).to_be_disabled()
        pw.expect(button(form, "\u4fdd\u5b58\u5e76\u751f\u6548")).to_be_disabled()
        button(shell, "\u5173\u95ed").click()
        page.unroute("**/api/models/config")
        trigger.click()
        pw.expect(dialog.locator(".model-layout")).to_be_visible()
        provider_filter(dialog).select_option("provider:beta")
        form.get_by_label("\u663e\u793a\u540d\u79f0", exact=True).fill("Save conflict draft")
        page.route("**/api/models/config", lambda route: pending.append(route))
        button(form, "\u4fdd\u5b58\u5e76\u751f\u6548").click()
        pw.expect(provider_filter(dialog)).to_be_disabled()
        pw.expect(dialog.locator(".model-search")).to_be_disabled()
        pw.expect(button(shell, "\u5173\u95ed")).to_be_disabled()
        assert len(pending) == 1
        pending.pop().fulfill(status=409, json={"error": "synthetic save conflict"})
        pw.expect(dialog.locator(".model-error")).to_contain_text("synthetic save conflict")
        pw.expect(button(form, "\u4fdd\u5b58\u5e76\u751f\u6548")).to_be_enabled()
        pw.expect(form.get_by_label("\u663e\u793a\u540d\u79f0", exact=True)).to_have_value("Save conflict draft")
        pw.expect(provider_filter(dialog)).to_have_value("provider:beta")
        assert store.source.file.read_bytes() == original
    finally:
        page.close()
