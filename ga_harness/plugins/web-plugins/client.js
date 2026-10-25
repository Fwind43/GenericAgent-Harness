GAH.define('web-plugins', api => {
  const { h } = api;
  const zh = typeof GAH_LANG !== 'undefined' && GAH_LANG === 'zh';
  const descOf = p => (zh && p.description_zh) || p.description || '';
  const labelOf = spec => (zh && spec.label_zh) || spec.label;
  const STATES = { active: T('\u8fd0\u884c\u4e2d','Running'), pending: T('\u7b49\u5f85\u4f9d\u8d56','Waiting for dependencies'), disabled: T('\u672a\u52a0\u8f7d','Not loaded'), error: T('\u52a0\u8f7d\u5931\u8d25','Failed to load'), removed: T('\u5df2\u79fb\u9664','Removed') };
  const PENDING = T(' \u00b7 \u5f85\u91cd\u542f\u751f\u6548',' · applies after restart'), PROTECTED = T(' \u00b7 \u53d7\u4fdd\u62a4',' · protected');
  const CATS = [['core', T('核心','Core'), T('核','C')], ['extension', T('GA 扩展','GA extensions'), T('扩','E')],
    ['observe', T('观测记录','Observability'), T('观','O')], ['service', T('数据与服务','Data & services'), T('数','S')],
    ['ui', T('界面','Interface'), T('界','U')], ['other', T('其他','Other'), T('其','?')]];
  const catOf = p => CATS.find(c => c[0] === p.category) || CATS[CATS.length - 1];
  const FILTERS = [['all', T('\u5168\u90e8','All')], ['active', T('\u8fd0\u884c\u4e2d','Running')], ['off', T('\u672a\u52a0\u8f7d','Not loaded')], ['issue', T('\u9700\u5904\u7406','Needs attention')]];
  let cfg = null, editing = null, view = 'grid', filter = 'all', busy = false, running = false, working = false;
  /* ---- toolbar ---- */
  const open = h('button', { type: 'button', class: 'side-item', 'data-gah-close': '', onclick: () => { view = 'grid'; load(); } },
    h('span', { class: 'gah-ico', dataset: { i: 'puzzle' }, 'aria-hidden': 'true' }), T('\u63d2\u4ef6\u7ba1\u7406','Plugins'));
  const summary = h('span', { class: 'plugin-note' }, T('\u66f4\u6539\u5728\u4e0b\u6b21\u542f\u52a8\u65f6\u751f\u6548','Changes take effect on next start'));
  summary.hidden = true;
  const group = h('div', { class: 'gah-plugins', hidden: true }, open, summary);
  /* ---- catalog (one card per plugin) ---- */
  const profile = h('p', { class: 'plugin-note plugin-profile' });
  const search = h('input', { type: 'search', class: 'plugin-search', placeholder: T('\u641c\u7d22\u63d2\u4ef6\u540d\u79f0\u6216\u8bf4\u660e','Search plugin names or descriptions'), 'aria-label': T('\u641c\u7d22\u63d2\u4ef6','Search plugins'), oninput: () => renderCards() });
  const reload = h('button', { type: 'button', class: 'secondary', onclick: () => load() }, T('\u5237\u65b0','Refresh'));
  const tabs = h('div', { class: 'plugin-filters', role: 'tablist', 'aria-label': T('\u6309\u72b6\u6001\u7b5b\u9009','Filter by status') });
  const cards = h('div', { class: 'plugin-groups', 'aria-label': T('\u63d2\u4ef6\u5217\u8868','Plugin list') });
  const empty = h('p', { class: 'plugin-empty', hidden: true });
  const catalogErr = h('p', { class: 'gah-error', role: 'status', hidden: true });
  const gridView = h('section', { class: 'plugin-catalog' },
    profile, h('div', { class: 'plugin-toolbar' }, search, reload), tabs, catalogErr, cards, empty);
  /* ---- detail (selected plugin) ---- */
  const back = h('button', { type: 'button', class: 'secondary plugin-back', onclick: () => showGrid() }, T('\u2190 \u5168\u90e8\u63d2\u4ef6','← All plugins'));
  const title = h('h3', { class: 'plugin-title' });
  const status = h('span', { class: 'plugin-badge plugin-status' });
  const tags = h('div', { class: 'plugin-tags' });
  const desc = h('p', { class: 'plugin-description' });
  const deps = { requires: h('dd'), provides: h('dd'), dependents: h('dd') };
  const warning = h('p', { class: 'plugin-note plugin-warning' });
  const enabled = h('input', { type: 'checkbox', role: 'switch' });
  const fields = h('div', { class: 'model-grid plugin-fields' });
  const note = h('p', { class: 'plugin-note' });
  const err = h('p', { class: 'gah-error', role: 'status', hidden: true });
  const resetBtn = h('button', { type: 'button', class: 'secondary plugin-reset', onclick: () => {
    if (confirm(T('\u6e05\u9664\u8fd9\u4e2a\u63d2\u4ef6\u7684\u7f51\u9875\u8986\u76d6\u8bbe\u7f6e\uff0c\u6062\u590d\u542f\u52a8\u914d\u7f6e\uff1f\u4e0b\u6b21\u542f\u52a8\u751f\u6548\u3002','Clear this plugin\'s web overrides and restore the startup config? Takes effect on next start.'))) change('reset'); } }, T('\u6062\u590d\u542f\u52a8\u914d\u7f6e','Restore startup config'));
  const saveBtn = h('button', { type: 'submit' }, T('\u4fdd\u5b58\uff0c\u4e0b\u6b21\u542f\u52a8\u751f\u6548','Save (applies on next start)'));
  const form = h('form', { onsubmit: e => { e.preventDefault(); change('save'); } },
    h('label', { class: 'plugin-toggle plugin-enable' }, enabled, h('span', null, T('\u4e0b\u6b21\u542f\u52a8\u65f6\u542f\u7528','Enable on next start'))),
    fields, note, err,
    h('div', { class: 'model-actions plugin-actions' }, resetBtn, saveBtn));
  const detailView = h('section', { class: 'plugin-detail', hidden: true }, back,
    h('div', { class: 'plugin-detail-card' },
      h('div', { class: 'plugin-detail-head' }, h('span', { class: 'plugin-avatar', 'aria-hidden': 'true' }), title, status),
      tags, desc,
      h('dl', { class: 'plugin-deps' }, h('dt', null, T('\u4f9d\u8d56\u80fd\u529b','Requires')), deps.requires,
        h('dt', null, T('\u63d0\u4f9b\u80fd\u529b','Provides')), deps.provides, h('dt', null, T('\u88ab\u63d2\u4ef6\u4f9d\u8d56','Required by')), deps.dependents),
      warning, form));
  const closeBtn = h('button', { type: 'button', class: 'secondary', 'aria-label': T('\u5173\u95ed\u63d2\u4ef6\u7ba1\u7406','Close plugins'), onclick: () => { if (!working) dlg.close(); } }, T('\u5173\u95ed','Close'));
  const dlg = h('dialog', { class: 'gah-dialog gah-plugin-dialog', 'aria-label': T('\u63d2\u4ef6\u7ba1\u7406','Plugins'),
      oncancel: e => { if (working) e.preventDefault(); else if (view === 'detail') { e.preventDefault(); showGrid(); } } },
    h('div', { class: 'dialog-head' }, h('h2', null, T('\u63d2\u4ef6\u7ba1\u7406','Plugins')), closeBtn),
    h('div', { class: 'dialog-content' }, gridView, detailView));
  const selected = () => cfg && cfg.items.find(x => x.name === editing);
  const issue = p => p.state === 'error' || p.state === 'pending' || !!(p.missing && p.missing.length) || !!p.error;
  const matches = (p, f) => f === 'all' || (f === 'active' ? p.state === 'active' : f === 'off' ? p.state === 'disabled' || p.state === 'removed' : issue(p));
  const stateLabel = p => STATES[p.state] || p.state;
  function badges(p) {
    const out = [];
    if (p.protected) out.push(['protected', T('\u53d7\u4fdd\u62a4','Protected')]);
    if (p.restart_required) out.push(['pending', T('\u5f85\u91cd\u542f','Restart pending')]);
    if (p.overridden) out.push(['override', T('\u7f51\u9875\u8986\u76d6','Web override')]);
    if (!p.enabled && p.state === 'active') out.push(['pending', T('\u4e0b\u6b21\u505c\u7528','Off next start')]);
    return out.map(([k, t]) => h('span', { class: 'plugin-tag', dataset: { tag: k } }, t));
  }
  function error(t) { err.textContent = t || ''; err.hidden = !t; catalogErr.textContent = t || ''; catalogErr.hidden = !t || view !== 'grid'; }
  function controls() {
    const p = selected(), b = working || busy, locked = b || running || !p || p.protected;
    open.disabled = b;
    search.disabled = reload.disabled = back.disabled = working;
    cards.querySelectorAll('button').forEach(x => { x.disabled = working; });
    closeBtn.disabled = working;
    enabled.disabled = saveBtn.disabled = locked;
    resetBtn.disabled = locked || !(p && p.overridden);
    fields.querySelectorAll('[data-plugin-field]').forEach(x => { x.disabled = locked; });
    note.textContent = running ? T('\u4efb\u52a1\u8fd0\u884c\u4e2d\uff0c\u4ec5\u53ef\u67e5\u770b\uff1b\u7ed3\u675f\u540e\u53ef\u4fdd\u5b58\u3002','A task is running; view only. You can save after it finishes.')
      : p && p.protected ? T('\u57fa\u7840\u80fd\u529b\u4e0e\u524d\u7aef\u53d7\u4fdd\u62a4\uff0c\u8bf7\u901a\u8fc7\u542f\u52a8\u914d\u7f6e\u8c03\u6574\u3002','Core and frontend plugins are protected; change them in the startup config.')
      : T('\u4ec5\u663e\u793a\u63d2\u4ef6\u58f0\u660e\u7684\u516c\u5f00\u914d\u7f6e\uff1b\u5bc6\u94a5\u8bf7\u5230\u6a21\u578b\u914d\u7f6e\u4e2d\u7ba1\u7406\u3002','Only public settings declared by the plugin are shown; manage keys in Models.');
  }
  function renderTabs() {
    const items = (cfg && cfg.items) || [];
    tabs.replaceChildren(...FILTERS.map(([k, t]) => h('button', { type: 'button', role: 'tab', class: 'plugin-filter',
      'aria-selected': String(filter === k), dataset: { filter: k }, onclick: () => { filter = k; renderTabs(); renderCards(); } },
      t, h('span', { class: 'plugin-count' }, String(items.filter(p => matches(p, k)).length)))));
  }
  function renderCards() {
    const q = search.value.trim().toLowerCase(), items = (cfg && cfg.items) || [];
    const shown = items.filter(p => matches(p, filter) && (!q || (p.name + ' ' + (p.description || '') + ' ' + (p.description_zh || '') + ' ' + catOf(p)[1]).toLowerCase().includes(q)));
    const card = p => h('li', null, h('button', { type: 'button', class: 'plugin-card', dataset: { plugin: p.name, state: p.state },
        'aria-label': p.name + T('\uff0c',', ') + stateLabel(p), onclick: () => showDetail(p.name) },
      h('span', { class: 'plugin-card-head' },
        h('span', { class: 'plugin-avatar', 'aria-hidden': 'true', dataset: { category: catOf(p)[0] } }, catOf(p)[2]),
        h('span', { class: 'plugin-name', title: p.name }, p.name),
        h('span', { class: 'plugin-badge', dataset: { state: p.state } }, stateLabel(p))),
      h('span', { class: 'plugin-card-desc' }, descOf(p) || T('\u6682\u65e0\u8bf4\u660e','No description')),
      h('span', { class: 'plugin-card-foot' }, ...badges(p),
        h('span', { class: 'plugin-card-meta' }, (p.provides && p.provides.length ? T('\u63d0\u4f9b ','Provides ') + p.provides.length + T(' \u9879\u80fd\u529b',' capabilities') : '')))));
    cards.replaceChildren(...CATS.map(c => [c, shown.filter(p => catOf(p) === c)]).filter(([, ps]) => ps.length).map(([c, ps]) =>
      h('section', { class: 'plugin-group', dataset: { category: c[0] } },
        h('h3', { class: 'plugin-group-title' }, c[1], h('span', { class: 'plugin-count' }, String(ps.length))),
        h('ul', { class: 'plugin-grid', 'aria-label': c[1] }, ...ps.map(card)))));
    empty.hidden = !!shown.length;
    empty.textContent = items.length ? T('\u6ca1\u6709\u7b26\u5408\u6761\u4ef6\u7684\u63d2\u4ef6','No matching plugins') : T('\u6ca1\u6709\u53d1\u73b0\u53ef\u7ba1\u7406\u7684\u63d2\u4ef6','No manageable plugins found');
    controls();
  }
  function fill(name) {
    editing = name; const p = selected(); fields.replaceChildren();
    title.textContent = p ? p.name : '';
    const av = detailView.querySelector('.plugin-avatar'); av.textContent = p ? catOf(p)[2] : ''; av.dataset.category = p ? catOf(p)[0] : '';
    status.textContent = p ? stateLabel(p) : T('\u6ca1\u6709\u53d1\u73b0\u53ef\u7ba1\u7406\u7684\u63d2\u4ef6','No manageable plugins found');
    status.dataset.state = p ? p.state : '';
    tags.replaceChildren(...(p ? badges(p) : []));
    desc.textContent = (p && descOf(p)) || T('\u6682\u65e0\u8bf4\u660e','No description');
    for (const k of Object.keys(deps)) deps[k].textContent = (p && p[k] && p[k].join(T('\u3001',', '))) || T('\u65e0','None');
    warning.textContent = [p && p.missing && p.missing.length ? T('\u5f53\u524d\u7f3a\u5c11\uff1a','Missing: ') + p.missing.join(T('\u3001',', ')) : '', (p && p.error) || ''].filter(Boolean).join(T('\uff1b','; '));
    warning.hidden = !warning.textContent;
    enabled.checked = !!(p && p.enabled);
    Object.entries((p && p.fields) || {}).forEach(([key, spec]) => {
      const bool = spec.type === 'boolean', choice = spec.type === 'choice';
      const input = choice ? h('select', null, ...(spec.options || []).map(o => h('option', { value: o.value }, (zh && o.label_zh) || o.label || o.value)))
        : spec.type === 'string' && spec.multiline ? h('textarea', { rows: 4 })
        : h('input', { type: bool ? 'checkbox' : spec.type === 'integer' ? 'number' : 'text' });
      input.dataset.pluginField = key;
      let label;
      if (bool) { input.checked = !!p.config[key]; label = h('label', { class: 'plugin-toggle' }, input, h('span', null, labelOf(spec) || key)); }
      else {
        input.value = p.config[key] ?? '';
        if (spec.type === 'integer') { input.step = '1'; if (spec.min != null) input.min = spec.min; if (spec.max != null) input.max = spec.max; }
        label = h('label', { class: 'model-field' }, h('span', null, labelOf(spec) || key), input);
      }
      if (spec.description || spec.description_zh) label.append(h('small', null, (zh && spec.description_zh) || spec.description));
      fields.append(label);
    });
    fields.hidden = !fields.childElementCount;
    controls();
  }
  function setView(v) { view = v; gridView.hidden = v !== 'grid'; detailView.hidden = v !== 'detail'; catalogErr.hidden = !catalogErr.textContent || v !== 'grid'; }
  function showGrid() { if (working) return; setView('grid'); error(''); renderCards(); const c = editing && cards.querySelector('[data-plugin="' + CSS.escape(editing) + '"]'); if (c) c.focus(); }
  function showDetail(name) { if (working) return; error(''); fill(name); setView('detail'); back.focus(); }
  function fillCatalog(preferred) {
    profile.textContent = T('\u914d\u7f6e\u65b9\u6848\uff1a','Profile: ') + cfg.profile + T('\u3002\u66f4\u6539\u4ec5\u4fdd\u5b58\u5230\u672c\u5730\uff0c\u4e0b\u6b21\u542f\u52a8\u751f\u6548\uff0c\u4e0d\u4e2d\u65ad\u5f53\u524d\u63d2\u4ef6\u3002','. Changes are saved locally and apply on next start without interrupting running plugins.');
    summary.hidden = !cfg.restart_required;
    summary.textContent = cfg.restart_required ? T('\u914d\u7f6e\u5df2\u4fdd\u5b58','Settings saved') + PENDING : T('\u66f4\u6539\u5728\u4e0b\u6b21\u542f\u52a8\u65f6\u751f\u6548','Changes take effect on next start');
    renderTabs(); renderCards();
    const keep = cfg.items.some(p => p.name === preferred);
    fill(keep ? preferred : null);
    if (view === 'detail' && !keep) setView('grid');
    if (cfg.issues && cfg.issues.length) error(T('\u4f9d\u8d56\u68c0\u67e5\uff1a','Dependency check: ') + cfg.issues.join(T('\uff1b','; ')));
  }
  function begin() { working = true; api.lock(true); controls(); }
  function end() { working = false; api.lock(false); controls(); }
  async function load() {
    if (working || busy) return;
    if (!dlg.open) dlg.showModal();
    setView(view); begin(); error('');
    try { cfg = await api.host.get('/api/plugins'); fillCatalog(editing); }
    catch (e) { cfg = null; renderTabs(); renderCards(); fill(null); setView('grid'); error(e.message); }
    finally { end(); }
  }
  async function change(action) {
    const p = selected(); if (working || busy || running || !p || p.protected) return;
    const body = { action, name: p.name, revision: cfg.revision };
    if (action === 'save') {
      body.enabled = enabled.checked; body.config = {};
      fields.querySelectorAll('[data-plugin-field]').forEach(f => {
        const key = f.dataset.pluginField, kind = p.fields[key].type;
        if (kind === 'boolean') body.config[key] = f.checked;
        else if (f.value !== '' || kind === 'string') body.config[key] = kind === 'integer' ? Number(f.value) : f.value;
      });
    }
    begin(); error('');
    try { cfg = await api.host.post('/api/plugins', body); fillCatalog(p.name); api.notice(T('\u63d2\u4ef6\u914d\u7f6e\u5df2\u4fdd\u5b58\uff1b\u4e0b\u6b21\u542f\u52a8\u65f6\u751f\u6548','Plugin settings saved; they apply on next start')); }
    catch (e) { error(e.message); }
    finally { end(); }
  }
  function render(s) { group.hidden = !(s && s.plugins_enabled); }
  api.onHost('state', render);
  api.onHost('sync', d => { running = !!d.running; busy = !!d.changing && !working; controls(); });
  api.slot('sidebar-foot', group);
  api.slot('overlay', dlg);
  const s = api.state(); render(s); running = !!(s && s.running); controls();
  return () => { if (dlg.open) dlg.close(); };
});
