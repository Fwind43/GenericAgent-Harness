"""Optional browser acceptance for native workspace/project extensions; no model calls."""
import os
import re
from pathlib import Path

import pytest

pw = pytest.importorskip("playwright.sync_api")
from tests.test_ui_web_output_browser import browser  # noqa: F401
from tests.test_ui_workspaces import workspace_app  # noqa: F401
from tests.test_ui_web import _req, _wait_idle


def screenshot(page, name):
    target = os.environ.get("GAH_WORKSPACE_ARTIFACTS")
    if target:
        path = Path(target)
        path.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(path / (name + ".png")), full_page=True)


def test_workspace_editor_lifecycle_and_responsive_themes(workspace_app, browser, tmp_path):
    _, _, _, base = workspace_app
    page = browser.new_page(viewport={"width": 1280, "height": 820})
    page.set_default_timeout(6000)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    try:
        page.goto(base)
        box = page.locator(".gah-workspaces")
        pw.expect(box).to_be_visible()
        pw.expect(box.locator(".gah-ws-row")).to_have_count(0)
        chip = page.locator(".gah-scope")
        pw.expect(chip).to_be_visible()
        pw.expect(chip.locator(".gah-scope-kind")).to_have_text("\u5de5\u4f5c\u533a")
        screenshot(page, "desktop-empty")
        create = box.get_by_role("button", name="\u65b0\u5efa\u9879\u76ee", exact=True)
        create.click()
        dialog = page.locator(".gah-ws-dialog")
        dialog.locator('[name="name"]').fill("Alpha \u9879\u76ee")
        dialog.locator('[name="workspace"]').fill(str(tmp_path / "not-present"))
        dialog.locator('[name="rules"]').fill("Only Alpha rules\n\u4e2d\u6587\u89c4\u5219")
        dialog.locator('[name="memory"]').fill("Shared notes\n\u4e2d\u6587\u7b14\u8bb0")
        dialog.locator('button[type="submit"]').click()
        pw.expect(dialog.locator('[role="alert"]')).not_to_be_empty()
        pw.expect(dialog).to_be_visible()
        dialog.locator('[name="workspace"]').fill(str(tmp_path))
        dialog.locator('button[type="submit"]').click()
        pw.expect(dialog).not_to_be_visible()
        pw.expect(box.locator(".gah-ws-row.current")).to_have_text("Alpha \u9879\u76ee")
        pw.expect(chip.locator(".gah-scope-name")).to_have_text("Alpha \u9879\u76ee")
        scope = _req(base + "api/state")[1]["scope"]
        project_id = scope["project_id"]
        assert scope["workspace"] == str(tmp_path.resolve())
        assert scope["project"]["memory"] == "Shared notes\n\u4e2d\u6587\u7b14\u8bb0"
        page.reload()
        pw.expect(box.locator(".gah-ws-row.current")).to_have_count(1)
        edit = chip.get_by_role("button", name="\u9879\u76ee\u89c4\u5219\u4e0e\u7b14\u8bb0", exact=True)
        edit.click()
        pw.expect(dialog.locator('[name="project_id"]')).to_have_value(project_id)
        pw.expect(dialog.locator('[name="project_id"]')).to_have_attribute("readonly", "")
        pw.expect(dialog.locator('[name="workspace"]')).to_have_attribute("readonly", "")
        dialog.locator('[name="memory"]').fill("Updated shared notes")
        dialog.locator('button[type="submit"]').click()
        pw.expect(dialog).not_to_be_visible()
        assert _req(base + "api/state")[1]["scope"]["project"]["memory"] == "Updated shared notes"
        palettes = set()
        for width in (1280, 390):
            page.set_viewport_size({"width": width, "height": 820})
            for theme in ("light", "dark", "warm"):
                page.locator("#theme").select_option(theme)
                pw.expect(page.locator("html")).to_have_attribute("data-theme", theme)
                palettes.add(page.evaluate("getComputedStyle(document.body).backgroundColor"))
                if width == 390:
                    page.locator("#sideOpen").click()
                    page.wait_for_timeout(220)
                pw.expect(create).to_be_visible()
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
                screenshot(page, f"{width}-{theme}-sidebar")
                if width == 390:
                    page.keyboard.press("Escape")
                    page.wait_for_timeout(220)
                pw.expect(chip).to_be_visible()
                assert chip.evaluate("e => e.scrollWidth <= e.clientWidth + 1")
                edit.click()
                pw.expect(dialog).to_be_visible()
                pw.expect(dialog.locator('[name="memory"]')).to_have_value("Updated shared notes")
                geometry = dialog.evaluate("e => {const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight,overflow:e.scrollWidth-e.clientWidth}}")
                assert geometry["left"] >= 0 and geometry["right"] <= geometry["w"] + 1, geometry
                assert geometry["top"] >= 0 and geometry["bottom"] <= geometry["h"] + 1, geometry
                assert geometry["overflow"] <= 1, geometry
                screenshot(page, f"{width}-{theme}-editor")
                dialog.get_by_role("button", name="\u53d6\u6d88", exact=True).click()
        assert len(palettes) == 3, palettes
        page.set_viewport_size({"width": 1280, "height": 820})
        chip.get_by_role("button", name="\u9000\u51fa\u9879\u76ee", exact=True).click()
        pw.expect(chip.locator(".gah-scope-name")).to_be_hidden()
        assert _req(base + "api/state")[1]["scope"]["project"] is None
        # slash commands: completion menu, enter by name, exit; nothing is sent to the model
        composer = page.locator("#input")
        composer.fill("/pro")
        pw.expect(page.locator(".gah-slash-item")).to_have_count(1)
        composer.fill("/project alpha")
        pw.expect(page.locator(".gah-slash-item").first).to_have_text(re.compile("Alpha"))
        composer.press("Enter")
        pw.expect(chip.locator(".gah-scope-name")).to_have_text("Alpha \u9879\u76ee")
        pw.expect(composer).to_have_value("")
        state = _req(base + "api/state")[1]
        assert state["scope"]["project_id"] == project_id and state["messages"] == []
        composer.fill("/project off")
        composer.press("Enter")
        pw.expect(chip.locator(".gah-scope-name")).to_be_hidden()
        composer.fill("/project nope")
        page.locator("#form").evaluate("f => f.requestSubmit()")
        pw.expect(page.locator("#notice")).to_contain_text("nope")
        assert _req(base + "api/state")[1]["messages"] == []
        chip.locator(".gah-ws-path").click()
        another = tmp_path / "another"
        another.mkdir()
        dialog.locator('[name="workspace"]').fill(str(another))
        dialog.locator('button[type="submit"]').click()
        pw.expect(dialog).not_to_be_visible()
        pw.expect(chip.locator(".gah-ws-path")).to_have_text(str(another.resolve()))
        assert _req(base + "api/run", {"task": "wait"})[0] == 202
        pw.expect(create).to_be_disabled()
        pw.expect(chip.locator(".gah-ws-path")).to_be_disabled()
        assert _req(base + "api/abort", {})[0] == 202
        _wait_idle(base)
        pw.expect(create).to_be_enabled()
        assert not errors, errors
    finally:
        page.close()
