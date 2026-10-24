GAH.define('web-sessions', api => {
  const { h } = api;
  let busy = false;
  // sidebar: "new session" on top, then one row per session (click = switch; hover shows rename / delete)
  const add = h('button', { type: 'button', class: 'side-item gah-sess-new', onclick: () => act('new') },
    h('span', { class: 'gah-sess-plus', 'aria-hidden': 'true' }, '+'), '\u65b0\u4f1a\u8bdd');
  const list = h('div', { class: 'gah-sess-list', role: 'list', 'aria-label': '\u4f1a\u8bdd\u5217\u8868' });
  const head = h('div', { class: 'gah-sess-label' }, '\u4f1a\u8bdd');
  const box = h('div', { class: 'gah-sessions', hidden: true }, add, head, list);
  function rename(x) {
    const title = prompt('\u4f1a\u8bdd\u540d\u79f0', x.title || '');
    if (title != null && title.trim()) act('rename', { id: x.id, title: title.trim() });
  }
  function remove(x) {
    if (confirm('\u4ece\u4f1a\u8bdd\u5217\u8868\u4e2d\u5220\u9664\u201c' + (x.title || '') + '\u201d\uff1f\u8bb0\u5f55\u5c06\u4fdd\u7559\u5728\u672c\u5730\u6570\u636e\u5e93\u4e2d\u3002')) act('delete', { id: x.id });
  }
  function row(x, cur) {
    const open = h('button', { type: 'button', class: 'gah-sess-open', 'data-gah-close': '', title: x.title,
      'aria-current': cur ? 'true' : null, onclick: () => { if (!cur) act('select', { id: x.id }); } },
      h('span', { class: 'gah-sess-title' }, x.title || '\u672a\u547d\u540d'));
    const ren = h('button', { type: 'button', class: 'gah-sess-act', title: '\u91cd\u547d\u540d', 'aria-label': '\u91cd\u547d\u540d', onclick: () => rename(x) }, '\u270e');
    const del = h('button', { type: 'button', class: 'gah-sess-act', title: '\u5220\u9664', 'aria-label': '\u5220\u9664', onclick: () => remove(x) }, '\u00d7');
    return h('div', { class: 'gah-sess-row' + (cur ? ' current' : ''), role: 'listitem' }, open, h('span', { class: 'gah-sess-acts' }, ren, del));
  }
  function render(s) {
    const items = s && s.sessions;
    box.hidden = !Array.isArray(items);
    if (!Array.isArray(items)) return;
    list.replaceChildren(...items.map(x => row(x, x.id === s.session_id)));
    sync(busy);
  }
  function sync(b) { busy = b; for (const n of box.querySelectorAll('button')) n.disabled = b; }
  async function act(action, extra = {}) {
    if (busy) return;
    const s = api.state();
    api.lock(true); api.notice('');
    try { api.setState(await api.host.post('/api/sessions', { action, id: s.session_id, ...extra }), true); }
    catch (e) { api.notice(e.message); render(api.state()); }
    finally { api.lock(false); }
  }
  api.onHost('state', render);
  api.onHost('sync', d => sync(d.running || d.changing));
  api.slot('sidebar', box);
  const s = api.state(); render(s); sync(!!(s && s.running));
});
