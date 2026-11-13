"""Optional real-browser regression for typed slots (frontend/src/slots.tsx).

Run like tests/test_ui_web_output_browser.py; it reads the built ui-web/dist.
"""
import pytest

pw = pytest.importorskip("playwright.sync_api")

from tests.test_ui_web_output_browser import browser, output_app, seeded_messages  # noqa: F401

PRELUDE = """
const h = GAH.React.createElement;
window.__slotErr = window.__slotErr || {};
const attempt = (key, fn) => { try { fn(); } catch (error) { window.__slotErr[key] = String(error && error.message || error); } };
"""


def plug(fe, tmp_path, name, body, order=100):
    folder = tmp_path / name
    folder.mkdir()
    script = folder / "client.js"
    script.write_text("(function () {%s\nGAH.define(%r, api => {%s\n});})();\n" % (PRELUDE, name, body), encoding="utf-8")
    fe.web.register(name, script=script, order=order)


def open_page(browser, base):
    page = browser.new_page(locale="zh-CN", viewport={"width": 1280, "height": 844})
    page.goto(base)
    return page


def expand(page):
    page.locator(".steps > summary").click()
    page.locator(".step > summary").click()


def errors(page):
    return page.evaluate("() => window.__slotErr || {}")


def test_single_slot_replaces_the_empty_view_once(output_app, browser, tmp_path):
    fe, _, base = output_app
    plug(fe, tmp_path, "slot-one", """
      api.slots.replace('empty', props => h('div', {className: 'x-empty'}, 'custom landing'));
    """, order=10)
    plug(fe, tmp_path, "slot-two", """
      attempt('second', () => api.slots.replace('empty', () => h('div', {className: 'x-empty-2'})));
      window.__slotTwo = true;
    """, order=20)
    page = open_page(browser, base)
    pw.expect(page.locator(".x-empty")).to_have_text("custom landing")
    page.wait_for_function("() => window.__slotTwo")
    assert page.locator(".empty").count() == 0 and page.locator(".x-empty-2").count() == 0
    assert 'already replaced by plugin "slot-one"' in errors(page)["second"]


def test_wrap_claim_and_add_change_existing_messages(output_app, browser, tmp_path):
    fe, _, base = output_app
    fe.messages = seeded_messages()
    plug(fe, tmp_path, "slot-ui", """
      api.slots.wrap('message', props => h('div', {className: 'x-wrap', 'data-role': props.message.role}, props.children));
      api.slots.claim('tool', props => props.tool.name === 'code_run',
        props => h('div', {className: 'x-tool'}, 'custom ' + props.tool.name));
      api.slots.claim('tool', props => props.tool.name === 'never', () => h('div', {className: 'x-never'}));
      api.slots.add('message.actions', props => h('span', {className: 'x-act'}, props.message.role));
      api.slots.add('message.footer', props => h('span', {className: 'x-foot'}, 'foot'), {order: 2});
      api.slots.add('message.footer', props => h('span', {className: 'x-foot-first'}, 'first'), {order: 1});
    """)
    page = open_page(browser, base)
    expand(page)
    page.wait_for_selector(".x-tool")
    assert errors(page) == {}
    assert page.locator(".x-wrap[data-role=assistant] .msg.assistant").count() == 1
    assert page.locator(".x-wrap[data-role=user]").count() == 1
    pw.expect(page.locator(".x-tool")).to_have_text("custom code_run")
    assert page.locator(".tool > summary").count() == 0 and page.locator(".x-never").count() == 0
    assert page.locator(".x-act").count() >= 1
    assert page.locator(".x-foot").count() >= 1
    assert page.locator(".x-foot-first").first.evaluate(
        "n => !!(n.compareDocumentPosition(n.parentElement.querySelector('.x-foot')) & Node.DOCUMENT_POSITION_FOLLOWING)")


def test_registration_is_validated_at_activation(output_app, browser, tmp_path):
    fe, _, base = output_app
    plug(fe, tmp_path, "slot-check", """
      const C = () => null;
      attempt('unknown', () => api.slots.add('nope', C));
      attempt('ghost', () => api.slots.add('ghost-plugin/items', C));
      attempt('own', () => api.slots.add('slot-check/undefined', C));
      attempt('method', () => api.slots.add('tool', C));
      attempt('replace', () => api.slots.replace('message', C));
      attempt('select', () => api.slots.claim('tool', 'nope', C));
      attempt('component', () => api.slots.add('message.footer', 'nope'));
      attempt('order', () => api.slots.add('message.footer', C, {order: NaN}));
      attempt('foreign', () => api.slots.define('other/items', 'list'));
      attempt('kind', () => api.slots.define('slot-check/items', 'bogus'));
      attempt('ok', () => api.slots.define('slot-check/items', 'list'));
      attempt('twice', () => api.slots.define('slot-check/items', 'list'));
      window.__slotCheck = true;
    """)
    page = open_page(browser, base)
    page.wait_for_function("() => window.__slotCheck")
    got = errors(page)
    assert "ok" not in got
    for key in ("unknown", "ghost", "own"):
        assert got[key].startswith("Unknown slot:"), got
    assert "message.footer" in got["unknown"]
    for key in ("method", "replace"):
        assert "slots." in got[key], got
    assert "select must be a function" in got["select"]
    assert "must be a React component" in got["component"]
    assert "order must be a finite number" in got["order"]
    assert 'must be named "slot-check/<slot>"' in got["foreign"]
    assert 'unknown kind "bogus"' in got["kind"]
    assert "already defined" in got["twice"]


def test_plugins_extend_slots_defined_by_other_plugins(output_app, browser, tmp_path):
    fe, _, base = output_app
    fe.messages = seeded_messages()
    plug(fe, tmp_path, "slot-early", """
      attempt('early', () => api.slots.add('slot-owner/items', props => h('i', {className: 'x-early'}, 'early ' + props.n)));
      attempt('early-missing', () => api.slots.add('slot-owner/missing', () => h('i', {className: 'x-missing'})));
    """, order=10)
    plug(fe, tmp_path, "slot-owner", """
      api.slots.define('slot-owner/items', 'list');
      api.slots.add('message.footer', () => h('div', {className: 'x-owner'},
        h(api.slots.Slot, {name: 'slot-owner/items', props: {n: 7}}, h('b', {className: 'x-default'}, 'default')),
        h(api.slots.Slot, {name: 'slot-owner/missing'})));
    """, order=20)
    plug(fe, tmp_path, "slot-late", """
      attempt('late', () => api.slots.add('slot-owner/items', props => h('i', {className: 'x-late'}, 'late ' + props.n)));
      attempt('late-missing', () => api.slots.add('slot-owner/missing', () => null));
      window.__slotLate = true;
    """, order=30)
    page = open_page(browser, base)
    page.wait_for_function("() => window.__slotLate")
    page.wait_for_selector(".x-late")
    got = errors(page)
    assert set(got) == {"late-missing"} and got["late-missing"].startswith("Unknown slot: slot-owner/missing"), got
    owner = page.locator(".x-owner").first
    assert owner.locator(".x-default").count() == 1
    pw.expect(owner.locator(".x-early")).to_have_text("early 7")
    pw.expect(owner.locator(".x-late")).to_have_text("late 7")
    assert page.locator(".x-missing").count() == 0
    pw.expect(page.locator("#notice")).to_contain_text("slot-owner/missing")


def test_failing_slot_components_fall_back_to_host_content(output_app, browser, tmp_path):
    fe, _, base = output_app
    fe.messages = seeded_messages()
    plug(fe, tmp_path, "slot-bad", """
      api.slots.wrap('message', () => { throw new Error('boom-wrap'); });
      api.slots.claim('tool', () => { throw new Error('boom-select'); }, () => h('div', {className: 'x-bad-tool'}));
      api.slots.add('message.footer', () => h('span', {className: 'x-ok'}, 'ok'));
    """)
    page = open_page(browser, base)
    page.wait_for_selector(".x-ok")
    assert page.locator(".msg.assistant").count() == 1
    expand(page)
    assert page.locator(".tool > summary").count() == 1 and page.locator(".x-bad-tool").count() == 0
    pw.expect(page.locator("#notice")).to_contain_text("boom")
