GAH.define('web-sessions', api => {
  const { h } = api;
  let busy = false;
  const sel = h('select', { 'aria-label': '\u5f53\u524d\u4f1a\u8bdd', onchange: () => act('select', { id: sel.value }) });
  const btn = (label, fn) => h('button', { type: 'button', class: 'secondary', onclick: fn }, label);
  const add = btn('\u65b0\u4f1a\u8bdd', () => act('new'));
  const rename = btn('\u91cd\u547d\u540d', () => {
    const s = api.state(), cur = (s.sessions || []).find(x => x.id === s.session_id);
    const title = prompt('\u4f1a\u8bdd\u540d\u79f0', (cur && cur.title) || '');
    if (title != null) act('rename', { title });
  });
  const del = btn('\u5220\u9664', () => {
    if (confirm('\u4ece\u4f1a\u8bdd\u5217\u8868\u4e2d\u5220\u9664\u5f53\u524d\u4f1a\u8bdd\uff1f\u8bb0\u5f55\u5c06\u4fdd\u7559\u5728\u672c\u5730\u6570\u636e\u5e93\u4e2d\u3002')) act('delete');
  });
  const group = h('div', { class: 'gah-group', role: 'group', 'aria-label': '\u4f1a\u8bdd\u7ba1\u7406', hidden: true }, sel, add, rename, del);
  function render(s) {
    const list = s && s.sessions;
    group.hidden = !Array.isArray(list);
    if (!Array.isArray(list)) return;
    sel.replaceChildren(...list.map(x => h('option', { value: x.id }, x.title)));
    sel.value = s.session_id;
  }
  function sync(b) { busy = b; for (const n of [sel, add, rename, del]) n.disabled = b; }
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
  api.slot('toolbar', group);
  const s = api.state(); render(s); sync(!!(s && s.running));
});
