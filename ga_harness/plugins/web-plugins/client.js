GAH.define('web-plugins', api => {
  const { h } = api;
  const STATES = { active: '\u8fd0\u884c\u4e2d', pending: '\u7b49\u5f85\u4f9d\u8d56', disabled: '\u672a\u52a0\u8f7d', error: '\u52a0\u8f7d\u5931\u8d25', removed: '\u5df2\u79fb\u9664' };
  const PENDING = ' \u00b7 \u5f85\u91cd\u542f\u751f\u6548', PROTECTED = ' \u00b7 \u53d7\u4fdd\u62a4';
  const FILTERS = [['all', '\u5168\u90e8'], ['active', '\u8fd0\u884c\u4e2d'], ['off', '\u672a\u52a0\u8f7d'], ['issue', '\u9700\u5904\u7406']];
  let cfg = null, editing = null, view = 'grid', filter = 'all', busy = false, running = false, working = false;
  /* ---- toolbar ---- */
  const open = h('button', { type: 'button', class: 'side-item', 'data-gah-close': '', onclick: () => { view = 'grid'; load(); } },
    h('span', { class: 'gah-ico', dataset: { i: 'puzzle' }, 'aria-hidden': 'true' }), '\u63d2\u4ef6\u7ba1\u7406');
  const summary = h('span', { class: 'plugin-note' }, '\u66f4\u6539\u5728\u4e0b\u6b21\u542f\u52a8\u65f6\u751f\u6548');
  summary.hidden = true;
  const group = h('div', { class: 'gah-plugins', hidden: true }, open, summary);
  /* ---- catalog (one card per plugin) ---- */
  const profile = h('p', { class: 'plugin-note plugin-profile' });
  const search = h('input', { type: 'search', class: 'plugin-search', placeholder: '\u641c\u7d22\u63d2\u4ef6\u540d\u79f0\u6216\u8bf4\u660e', 'aria-label': '\u641c\u7d22\u63d2\u4ef6', oninput: () => renderCards() });
  const reload = h('button', { type: 'button', class: 'secondary', onclick: () => load() }, '\u5237\u65b0');
  const tabs = h('div', { class: 'plugin-filters', role: 'tablist', 'aria-label': '\u6309\u72b6\u6001\u7b5b\u9009' });
  const cards = h('ul', { class: 'plugin-grid', 'aria-label': '\u63d2\u4ef6\u5217\u8868' });
  const empty = h('p', { class: 'plugin-empty', hidden: true });
  const catalogErr = h('p', { class: 'gah-error', role: 'status', hidden: true });
  const gridView = h('section', { class: 'plugin-catalog' },
    profile, h('div', { class: 'plugin-toolbar' }, search, reload), tabs, catalogErr, cards, empty);
  /* ---- detail (selected plugin) ---- */
  const back = h('button', { type: 'button', class: 'secondary plugin-back', onclick: () => showGrid() }, '\u2190 \u5168\u90e8\u63d2\u4ef6');
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
    if (confirm('\u6e05\u9664\u8fd9\u4e2a\u63d2\u4ef6\u7684\u7f51\u9875\u8986\u76d6\u8bbe\u7f6e\uff0c\u6062\u590d\u542f\u52a8\u914d\u7f6e\uff1f\u4e0b\u6b21\u542f\u52a8\u751f\u6548\u3002')) change('reset'); } }, '\u6062\u590d\u542f\u52a8\u914d\u7f6e');
  const saveBtn = h('button', { type: 'submit' }, '\u4fdd\u5b58\uff0c\u4e0b\u6b21\u542f\u52a8\u751f\u6548');
  const form = h('form', { onsubmit: e => { e.preventDefault(); change('save'); } },
    h('label', { class: 'plugin-toggle plugin-enable' }, enabled, h('span', null, '\u4e0b\u6b21\u542f\u52a8\u65f6\u542f\u7528')),
    fields, note, err,
    h('div', { class: 'model-actions plugin-actions' }, resetBtn, saveBtn));
  const detailView = h('section', { class: 'plugin-detail', hidden: true }, back,
    h('div', { class: 'plugin-detail-card' },
      h('div', { class: 'plugin-detail-head' }, h('span', { class: 'plugin-avatar', 'aria-hidden': 'true' }), title, status),
      tags, desc,
      h('dl', { class: 'plugin-deps' }, h('dt', null, '\u4f9d\u8d56\u80fd\u529b'), deps.requires,
        h('dt', null, '\u63d0\u4f9b\u80fd\u529b'), deps.provides, h('dt', null, '\u88ab\u63d2\u4ef6\u4f9d\u8d56'), deps.dependents),
      warning, form));
  const closeBtn = h('button', { type: 'button', class: 'secondary', 'aria-label': '\u5173\u95ed\u63d2\u4ef6\u7ba1\u7406', onclick: () => { if (!working) dlg.close(); } }, '\u5173\u95ed');
  const dlg = h('dialog', { class: 'gah-dialog gah-plugin-dialog', 'aria-label': '\u63d2\u4ef6\u7ba1\u7406',
      oncancel: e => { if (working) e.preventDefault(); else if (view === 'detail') { e.preventDefault(); showGrid(); } } },
    h('div', { class: 'dialog-head' }, h('h2', null, '\u63d2\u4ef6\u7ba1\u7406'), closeBtn),
    h('div', { class: 'dialog-content' }, gridView, detailView));
  const selected = () => cfg && cfg.items.find(x => x.name === editing);
  const issue = p => p.state === 'error' || p.state === 'pending' || !!(p.missing && p.missing.length) || !!p.error;
  const matches = (p, f) => f === 'all' || (f === 'active' ? p.state === 'active' : f === 'off' ? p.state === 'disabled' || p.state === 'removed' : issue(p));
  const stateLabel = p => STATES[p.state] || p.state;
  function badges(p) {
    const out = [];
    if (p.protected) out.push(['protected', '\u53d7\u4fdd\u62a4']);
    if (p.restart_required) out.push(['pending', '\u5f85\u91cd\u542f']);
    if (p.overridden) out.push(['override', '\u7f51\u9875\u8986\u76d6']);
    if (!p.enabled && p.state === 'active') out.push(['pending', '\u4e0b\u6b21\u505c\u7528']);
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
    fields.querySelectorAll('input').forEach(x => { x.disabled = locked; });
    note.textContent = running ? '\u4efb\u52a1\u8fd0\u884c\u4e2d\uff0c\u4ec5\u53ef\u67e5\u770b\uff1b\u7ed3\u675f\u540e\u53ef\u4fdd\u5b58\u3002'
      : p && p.protected ? '\u57fa\u7840\u80fd\u529b\u4e0e\u524d\u7aef\u53d7\u4fdd\u62a4\uff0c\u8bf7\u901a\u8fc7\u542f\u52a8\u914d\u7f6e\u8c03\u6574\u3002'
      : '\u4ec5\u663e\u793a\u63d2\u4ef6\u58f0\u660e\u7684\u516c\u5f00\u914d\u7f6e\uff1b\u5bc6\u94a5\u8bf7\u5230\u6a21\u578b\u914d\u7f6e\u4e2d\u7ba1\u7406\u3002';
  }
  function renderTabs() {
    const items = (cfg && cfg.items) || [];
    tabs.replaceChildren(...FILTERS.map(([k, t]) => h('button', { type: 'button', role: 'tab', class: 'plugin-filter',
      'aria-selected': String(filter === k), dataset: { filter: k }, onclick: () => { filter = k; renderTabs(); renderCards(); } },
      t, h('span', { class: 'plugin-count' }, String(items.filter(p => matches(p, k)).length)))));
  }
  function renderCards() {
    const q = search.value.trim().toLowerCase(), items = (cfg && cfg.items) || [];
    const shown = items.filter(p => matches(p, filter) && (!q || (p.name + ' ' + (p.description || '')).toLowerCase().includes(q)));
    cards.replaceChildren(...shown.map(p => h('li', null, h('button', { type: 'button', class: 'plugin-card', dataset: { plugin: p.name, state: p.state },
        'aria-label': p.name + '\uff0c' + stateLabel(p), onclick: () => showDetail(p.name) },
      h('span', { class: 'plugin-card-head' },
        h('span', { class: 'plugin-avatar', 'aria-hidden': 'true' }, p.name.slice(0, 1).toUpperCase()),
        h('span', { class: 'plugin-name', title: p.name }, p.name),
        h('span', { class: 'plugin-badge', dataset: { state: p.state } }, stateLabel(p))),
      h('span', { class: 'plugin-card-desc' }, p.description || '\u6682\u65e0\u8bf4\u660e'),
      h('span', { class: 'plugin-card-foot' }, ...badges(p),
        h('span', { class: 'plugin-card-meta' }, (p.provides && p.provides.length ? '\u63d0\u4f9b ' + p.provides.length + ' \u9879\u80fd\u529b' : '')))))));
    empty.hidden = !!shown.length;
    empty.textContent = items.length ? '\u6ca1\u6709\u7b26\u5408\u6761\u4ef6\u7684\u63d2\u4ef6' : '\u6ca1\u6709\u53d1\u73b0\u53ef\u7ba1\u7406\u7684\u63d2\u4ef6';
    controls();
  }
  function fill(name) {
    editing = name; const p = selected(); fields.replaceChildren();
    title.textContent = p ? p.name : '';
    detailView.querySelector('.plugin-avatar').textContent = p ? p.name.slice(0, 1).toUpperCase() : '';
    status.textContent = p ? stateLabel(p) : '\u6ca1\u6709\u53d1\u73b0\u53ef\u7ba1\u7406\u7684\u63d2\u4ef6';
    status.dataset.state = p ? p.state : '';
    tags.replaceChildren(...(p ? badges(p) : []));
    desc.textContent = (p && p.description) || '\u6682\u65e0\u8bf4\u660e';
    for (const k of Object.keys(deps)) deps[k].textContent = (p && p[k] && p[k].join('\u3001')) || '\u65e0';
    warning.textContent = [p && p.missing && p.missing.length ? '\u5f53\u524d\u7f3a\u5c11\uff1a' + p.missing.join('\u3001') : '', (p && p.error) || ''].filter(Boolean).join('\uff1b');
    warning.hidden = !warning.textContent;
    enabled.checked = !!(p && p.enabled);
    Object.entries((p && p.fields) || {}).forEach(([key, spec]) => {
      const bool = spec.type === 'boolean', input = h('input', { type: bool ? 'checkbox' : spec.type === 'integer' ? 'number' : 'text' });
      input.dataset.pluginField = key;
      let label;
      if (bool) { input.checked = !!p.config[key]; label = h('label', { class: 'plugin-toggle' }, input, h('span', null, spec.label || key)); }
      else {
        input.value = p.config[key] ?? '';
        if (spec.type === 'integer') { input.step = '1'; if (spec.min != null) input.min = spec.min; if (spec.max != null) input.max = spec.max; }
        label = h('label', { class: 'model-field' }, h('span', null, spec.label || key), input);
      }
      if (spec.description) label.append(h('small', null, spec.description));
      fields.append(label);
    });
    fields.hidden = !fields.childElementCount;
    controls();
  }
  function setView(v) { view = v; gridView.hidden = v !== 'grid'; detailView.hidden = v !== 'detail'; catalogErr.hidden = !catalogErr.textContent || v !== 'grid'; }
  function showGrid() { if (working) return; setView('grid'); error(''); renderCards(); const c = editing && cards.querySelector('[data-plugin="' + CSS.escape(editing) + '"]'); if (c) c.focus(); }
  function showDetail(name) { if (working) return; error(''); fill(name); setView('detail'); back.focus(); }
  function fillCatalog(preferred) {
    profile.textContent = '\u914d\u7f6e\u65b9\u6848\uff1a' + cfg.profile + '\u3002\u66f4\u6539\u4ec5\u4fdd\u5b58\u5230\u672c\u5730\uff0c\u4e0b\u6b21\u542f\u52a8\u751f\u6548\uff0c\u4e0d\u4e2d\u65ad\u5f53\u524d\u63d2\u4ef6\u3002';
    summary.hidden = !cfg.restart_required;
    summary.textContent = cfg.restart_required ? '\u914d\u7f6e\u5df2\u4fdd\u5b58' + PENDING : '\u66f4\u6539\u5728\u4e0b\u6b21\u542f\u52a8\u65f6\u751f\u6548';
    renderTabs(); renderCards();
    const keep = cfg.items.some(p => p.name === preferred);
    fill(keep ? preferred : null);
    if (view === 'detail' && !keep) setView('grid');
    if (cfg.issues && cfg.issues.length) error('\u4f9d\u8d56\u68c0\u67e5\uff1a' + cfg.issues.join('\uff1b'));
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
      fields.querySelectorAll('input').forEach(f => {
        const key = f.dataset.pluginField, kind = p.fields[key].type;
        if (kind === 'boolean') body.config[key] = f.checked;
        else if (f.value !== '' || kind === 'string') body.config[key] = kind === 'integer' ? Number(f.value) : f.value;
      });
    }
    begin(); error('');
    try { cfg = await api.host.post('/api/plugins', body); fillCatalog(p.name); api.notice('\u63d2\u4ef6\u914d\u7f6e\u5df2\u4fdd\u5b58\uff1b\u4e0b\u6b21\u542f\u52a8\u65f6\u751f\u6548'); }
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
