GAH.define('web-sessions', api => {
  const { h } = api;
  let busy = false;
  // Sidebar: "new session" (in the current scope) on top, then sessions grouped by
  // project / workspace when web-workspaces provides `scope`; a flat list otherwise.
  // Group "+" opens a conversation in that scope (an empty current one is rebound in place).
  const KEY = 'gah.sessions.groups';
  let toggled = {}, lastScope = null;
  try { toggled = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { toggled = {}; }
  const add = h('button', { type: 'button', class: 'side-item gah-sess-new', 'data-gah-close': '', onclick: () => act('new') },
    h('span', { class: 'gah-ico', dataset: { i: 'pen' }, 'aria-hidden': 'true' }), '\u65b0\u4f1a\u8bdd');
  const list = h('div', { class: 'gah-sess-list', 'aria-label': '\u4f1a\u8bdd\u5217\u8868' });
  const newProject = h('button', { type: 'button', class: 'gah-sess-head-btn', title: '\u65b0\u5efa\u9879\u76ee', 'aria-label': '\u65b0\u5efa\u9879\u76ee',
    onclick: () => window.dispatchEvent(new CustomEvent('gah:workspace-dialog', { detail: { action: 'create' } })) }, h('span', { class: 'gah-ico', dataset: { i: 'folder-plus' }, 'aria-hidden': 'true' }));
  const head = h('div', { class: 'gah-sess-label' }, h('span', {}, '\u4f1a\u8bdd'), newProject);
  const box = h('div', { class: 'gah-sessions', hidden: true }, add, head, list);
  const base = p => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || '');
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
    const ren = h('button', { type: 'button', class: 'gah-sess-act', title: '\u91cd\u547d\u540d', 'aria-label': '\u91cd\u547d\u540d', onclick: () => rename(x) }, h('span', { class: 'gah-ico', dataset: { i: 'pencil' }, 'aria-hidden': 'true' }));
    const del = h('button', { type: 'button', class: 'gah-sess-act', title: '\u5220\u9664', 'aria-label': '\u5220\u9664', onclick: () => remove(x) }, h('span', { class: 'gah-ico', dataset: { i: 'trash' }, 'aria-hidden': 'true' }));
    return h('div', { class: 'gah-sess-row' + (cur ? ' current' : ''), role: 'listitem' }, open, h('span', { class: 'gah-sess-acts' }, ren, del));
  }
  // [{key, kind:'project'|'workspace', name, title, body, items, current}]
  function groups(s, items) {
    const scope = s.scope, projects = scope.projects || [], byId = {}, out = [], index = {};
    for (const p of projects) byId[p.id] = p;
    const get = (key, make) => index[key] || (out.push(index[key] = make()), index[key]);
    for (const x of items) {
      const p = x.project_id && byId[x.project_id];
      const g = p
        ? get('p:' + p.id, () => ({ key: 'p:' + p.id, kind: 'project', name: p.name, title: p.workspace, body: { id: p.id }, items: [] }))
        : get('w:' + x.workspace, () => ({ key: 'w:' + x.workspace, kind: 'workspace', name: base(x.workspace), title: x.workspace, body: { workspace: x.workspace }, items: [] }));
      g.items.push(x);
    }
    for (const p of projects) get('p:' + p.id, () => ({ key: 'p:' + p.id, kind: 'project', name: p.name, title: p.workspace, body: { id: p.id }, items: [] }));
    const cur = scope.project_id ? 'p:' + scope.project_id : 'w:' + scope.workspace;
    if (!index[cur] && !scope.project_id) get(cur, () => ({ key: cur, kind: 'workspace', name: base(scope.workspace), title: scope.workspace, body: { workspace: scope.workspace }, items: [] }));
    for (const g of out) g.current = g.key === cur;
    // Entering a scope always reveals it; a manual collapse only sticks while it stays current.
    // (the first render after a page load is not a switch, so a saved collapse survives reload).
    if (cur !== lastScope) { if (lastScope !== null) delete toggled[cur]; lastScope = cur; }
    return out;
  }
  function group(g, sid) {
    const open = g.key in toggled ? toggled[g.key] : g.current;
    const items = h('div', { class: 'gah-sess-items', role: 'list', hidden: !open });
    items.append(...g.items.map(x => row(x, x.id === sid)));
    if (!g.items.length) items.append(h('div', { class: 'gah-sess-empty' }, '\u6682\u65e0\u4f1a\u8bdd'));
    const toggle = h('button', { type: 'button', class: 'gah-group-toggle', 'aria-expanded': String(open), title: g.title,
      onclick: () => {
        const next = items.hidden;
        items.hidden = !next; toggle.setAttribute('aria-expanded', String(next));
        toggled[g.key] = next;
        try { localStorage.setItem(KEY, JSON.stringify(toggled)); } catch (e) {}
      } },
      h('span', { class: 'gah-ico gah-ico-closed', dataset: { i: 'folder' }, 'aria-hidden': 'true' }),
      h('span', { class: 'gah-ico gah-ico-open', dataset: { i: 'folder-open' }, 'aria-hidden': 'true' }),
      h('span', { class: 'gah-group-name' }, g.name));
    const plus = h('button', { type: 'button', class: 'gah-group-add', 'data-gah-close': '',
      title: '\u5728\u6b64' + (g.kind === 'project' ? '\u9879\u76ee' : '\u5de5\u4f5c\u533a') + '\u65b0\u5efa\u5bf9\u8bdd',
      'aria-label': '\u5728 ' + g.name + ' \u65b0\u5efa\u5bf9\u8bdd',
      onclick: () => g.current ? act('new') : enter(g.body) }, h('span', { class: 'gah-ico', dataset: { i: 'plus' }, 'aria-hidden': 'true' }));
    return h('section', { class: 'gah-group ' + g.kind + (g.current ? ' current' : ''), dataset: { key: g.key } },
      h('div', { class: 'gah-group-head' }, toggle, plus), items);
  }
  function render(s) {
    const items = s && s.sessions;
    box.hidden = !Array.isArray(items);
    if (!Array.isArray(items)) return;
    newProject.hidden = !s.scope;
    if (s.scope) {
      list.removeAttribute('role');
      list.replaceChildren(...groups(s, items).map(g => group(g, s.session_id)));
    } else {
      list.setAttribute('role', 'list');
      list.replaceChildren(...items.map(x => row(x, x.id === s.session_id)));
    }
    sync(busy);
  }
  function sync(b) { busy = b; for (const n of box.querySelectorAll('button:not(.gah-group-toggle)')) n.disabled = b; }
  async function run(fn) {
    if (busy) return;
    api.lock(true); api.notice('');
    try { const prev = api.state().session_id, next = await fn(); api.setState(next, next.session_id !== prev); }
    catch (e) { api.notice(e.message); render(api.state()); }
    finally { api.lock(false); }
  }
  const act = (action, extra = {}) => run(() => api.host.post('/api/sessions', { action, id: api.state().session_id, ...extra }));
  const enter = body => run(() => api.host.post('/api/p/web-workspaces/', { action: 'enter', ...body }));
  api.onHost('state', render);
  api.onHost('sync', d => sync(d.running || d.changing));
  api.slot('sidebar', box);
  const s = api.state(); render(s); sync(!!(s && s.running));
});
