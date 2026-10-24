GAH.define('web-plugins', api => {
  const { h } = api;
  const STATES = { active: '\u8fd0\u884c\u4e2d', pending: '\u7b49\u5f85\u4f9d\u8d56', disabled: '\u672a\u52a0\u8f7d', error: '\u52a0\u8f7d\u5931\u8d25', removed: '\u5df2\u79fb\u9664' };
  const PENDING = ' \u00b7 \u5f85\u91cd\u542f\u751f\u6548', PROTECTED = ' \u00b7 \u53d7\u4fdd\u62a4';
  let cfg = null, editing = null, busy = false, running = false, working = false;
  /* ---- toolbar ---- */
  const open = h('button', { type: 'button', class: 'side-item', 'data-gah-close': '', onclick: () => load() },
    h('span', { class: 'gah-side-icon', 'aria-hidden': 'true' }, '\u29c9'), '\u63d2\u4ef6\u7ba1\u7406');
  const summary = h('span', { class: 'plugin-note' }, '\u66f4\u6539\u5728\u4e0b\u6b21\u542f\u52a8\u65f6\u751f\u6548');
  summary.hidden = true;
  const group = h('div', { class: 'gah-plugins', hidden: true }, open, summary);
  /* ---- dialog ---- */
  const profile = h('p', { class: 'plugin-note' });
  const entry = h('select', { 'aria-label': '\u9009\u62e9\u63d2\u4ef6', onchange: () => fill(entry.value) });
  const reload = h('button', { type: 'button', class: 'secondary', onclick: () => load() }, '\u5237\u65b0');
  const status = h('p', { class: 'plugin-status' });
  const desc = h('p', { class: 'plugin-description' });
  const deps = { requires: h('dd'), provides: h('dd'), dependents: h('dd') };
  const warning = h('p', { class: 'plugin-note' });
  const enabled = h('input', { type: 'checkbox' });
  const fields = h('div', { class: 'model-grid plugin-fields' });
  const note = h('p', { class: 'plugin-note' });
  const err = h('p', { class: 'gah-error', role: 'status', hidden: true });
  const resetBtn = h('button', { type: 'button', class: 'secondary plugin-reset', onclick: () => {
    if (confirm('\u6e05\u9664\u8fd9\u4e2a\u63d2\u4ef6\u7684\u7f51\u9875\u8986\u76d6\u8bbe\u7f6e\uff0c\u6062\u590d\u542f\u52a8\u914d\u7f6e\uff1f\u4e0b\u6b21\u542f\u52a8\u751f\u6548\u3002')) change('reset'); } }, '\u6062\u590d\u542f\u52a8\u914d\u7f6e');
  const saveBtn = h('button', { type: 'submit' }, '\u4fdd\u5b58\uff0c\u4e0b\u6b21\u542f\u52a8\u751f\u6548');
  const closeBtn = h('button', { type: 'button', class: 'secondary', 'aria-label': '\u5173\u95ed\u63d2\u4ef6\u7ba1\u7406', onclick: () => { if (!working) dlg.close(); } }, '\u5173\u95ed');
  const form = h('form', { onsubmit: e => { e.preventDefault(); change('save'); } },
    h('label', { class: 'plugin-toggle' }, enabled, '\u4e0b\u6b21\u542f\u52a8\u65f6\u542f\u7528'),
    fields, note, err,
    h('div', { class: 'model-actions plugin-actions' }, resetBtn, saveBtn));
  const dlg = h('dialog', { class: 'gah-dialog gah-plugin-dialog', 'aria-label': '\u63d2\u4ef6\u7ba1\u7406',
      oncancel: e => { if (working) e.preventDefault(); } },
    h('div', { class: 'dialog-head' }, h('h2', null, '\u63d2\u4ef6\u7ba1\u7406'), closeBtn),
    h('div', { class: 'dialog-content' }, profile,
      h('div', { class: 'model-picker' }, entry, reload),
      status, desc,
      h('dl', { class: 'plugin-deps' }, h('dt', null, '\u4f9d\u8d56\u80fd\u529b'), deps.requires,
        h('dt', null, '\u63d0\u4f9b\u80fd\u529b'), deps.provides, h('dt', null, '\u88ab\u63d2\u4ef6\u4f9d\u8d56'), deps.dependents),
      warning, form));
  const selected = () => cfg && cfg.items.find(x => x.name === editing);
  function error(t) { err.textContent = t || ''; err.hidden = !t; }
  function controls() {
    const p = selected(), b = working || busy, locked = b || running || !p || p.protected;
    open.disabled = b;
    entry.disabled = reload.disabled = working;
    closeBtn.disabled = working;
    enabled.disabled = saveBtn.disabled = locked;
    resetBtn.disabled = locked || !(p && p.overridden);
    fields.querySelectorAll('input').forEach(x => { x.disabled = locked; });
    note.textContent = running ? '\u4efb\u52a1\u8fd0\u884c\u4e2d\uff0c\u4ec5\u53ef\u67e5\u770b\uff1b\u7ed3\u675f\u540e\u53ef\u4fdd\u5b58\u3002'
      : p && p.protected ? '\u57fa\u7840\u80fd\u529b\u4e0e\u524d\u7aef\u53d7\u4fdd\u62a4\uff0c\u8bf7\u901a\u8fc7\u542f\u52a8\u914d\u7f6e\u8c03\u6574\u3002'
      : '\u4ec5\u663e\u793a\u63d2\u4ef6\u58f0\u660e\u7684\u516c\u5f00\u914d\u7f6e\uff1b\u5bc6\u94a5\u8bf7\u5230\u6a21\u578b\u914d\u7f6e\u4e2d\u7ba1\u7406\u3002';
  }
  function fill(name) {
    editing = name; const p = selected(); fields.replaceChildren();
    entry.value = p ? p.name : '';
    status.textContent = p ? (STATES[p.state] || p.state) + (p.restart_required ? PENDING : '') + (p.protected ? PROTECTED : '') : '\u6ca1\u6709\u53d1\u73b0\u53ef\u7ba1\u7406\u7684\u63d2\u4ef6';
    desc.textContent = (p && p.description) || '';
    for (const k of Object.keys(deps)) deps[k].textContent = (p && p[k] && p[k].join('\u3001')) || '\u65e0';
    warning.textContent = [p && p.missing && p.missing.length ? '\u5f53\u524d\u7f3a\u5c11\uff1a' + p.missing.join('\u3001') : '', (p && p.error) || ''].filter(Boolean).join('\uff1b');
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
    error(''); controls();
  }
  function fillCatalog(preferred) {
    entry.replaceChildren(...cfg.items.map(p => h('option', { value: p.name }, p.name + (p.restart_required ? ' \u00b7 \u5f85\u91cd\u542f' : '') + (p.protected ? PROTECTED : ''))));
    profile.textContent = '\u914d\u7f6e\u65b9\u6848\uff1a' + cfg.profile + '\u3002\u66f4\u6539\u4ec5\u4fdd\u5b58\u5230\u672c\u5730\uff0c\u4e0b\u6b21\u542f\u52a8\u751f\u6548\uff0c\u4e0d\u4e2d\u65ad\u5f53\u524d\u63d2\u4ef6\u3002';
    summary.hidden = !cfg.restart_required;
    summary.textContent = cfg.restart_required ? '\u914d\u7f6e\u5df2\u4fdd\u5b58' + PENDING : '\u66f4\u6539\u5728\u4e0b\u6b21\u542f\u52a8\u65f6\u751f\u6548';
    fill(cfg.items.some(p => p.name === preferred) ? preferred : (cfg.items[0] && cfg.items[0].name));
    if (cfg.issues && cfg.issues.length) error('\u4f9d\u8d56\u68c0\u67e5\uff1a' + cfg.issues.join('\uff1b'));
  }
  function begin() { working = true; api.lock(true); controls(); }
  function end() { working = false; api.lock(false); controls(); }
  async function load() {
    if (working || busy) return;
    if (!dlg.open) dlg.showModal();
    begin(); error('');
    try { cfg = await api.host.get('/api/plugins'); fillCatalog(editing); }
    catch (e) { cfg = null; fill(null); error(e.message); }
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
