GAH.define('web-models', api => {
  const { h } = api;
  let cfg = null, editingKey = null, busy = false, working = false;
  const field = (label, input, extra = {}, hint) => h('label', { class: 'model-field' + (extra.wide ? ' wide' : '') }, label, input, hint || null);
  /* ---- toolbar ---- */
  const pick = h('select', { 'aria-label': '\u5f53\u524d\u6a21\u578b', onchange: () => select(Number(pick.value)) });
  const open = h('button', { type: 'button', class: 'secondary', onclick: () => openDialog() }, '\u6a21\u578b\u914d\u7f6e');
  const group = h('div', { class: 'gah-group gah-models', role: 'group', 'aria-label': '\u6a21\u578b\u7ba1\u7406', hidden: true },
    h('span', { class: 'gah-label' }, '\u6a21\u578b'), pick, open);
  /* ---- dialog ---- */
  const entry = h('select', { 'aria-label': '\u9009\u62e9\u914d\u7f6e', onchange: () => fill(entry.value) });
  const addBtn = h('button', { type: 'button', class: 'secondary', onclick: () => { fill(null); name.focus(); } }, '\u65b0\u589e');
  const reason = h('p', { class: 'model-help', hidden: true });
  const protocol = h('select', { onchange: () => { if (editingKey === null) key.value = 'native_' + protocol.value + '_config_' + Date.now(); } },
    h('option', { value: 'oai' }, 'OpenAI compatible'), h('option', { value: 'claude' }, 'Anthropic Claude'));
  const name = h('input', { maxlength: '120', autocomplete: 'off' });
  const key = h('input', { required: true, pattern: '[A-Za-z][A-Za-z0-9_]{0,99}', autocomplete: 'off' });
  const model = h('input', { required: true, autocomplete: 'off', placeholder: 'gpt-4.1' });
  const ctxwin = h('input', { type: 'number', min: '1024', step: '1', placeholder: '131072' });
  const base = h('input', { required: true, autocomplete: 'off', placeholder: 'https://api.openai.com/v1' });
  const secret = h('input', { type: 'password', autocomplete: 'new-password' });
  const secretHint = h('small');
  const err = h('p', { class: 'gah-error', role: 'status', hidden: true });
  const removeBtn = h('button', { type: 'button', class: 'secondary', onclick: () => {
    if (confirm('\u5220\u9664\u6b64\u6a21\u578b\u914d\u7f6e\uff1f\u81f3\u5c11\u9700\u4fdd\u7559\u4e00\u4e2a\u6a21\u578b\u3002')) change('delete'); } }, '\u5220\u9664\u914d\u7f6e');
  const saveBtn = h('button', { type: 'submit' }, '\u4fdd\u5b58\u5e76\u751f\u6548');
  const closeBtn = h('button', { type: 'button', class: 'secondary', onclick: () => dlg.close() }, '\u5173\u95ed');
  const form = h('form', { onsubmit: e => { e.preventDefault(); change('save'); } },
    h('div', { class: 'model-grid' },
      field('\u534f\u8bae', protocol),
      field('\u663e\u793a\u540d\u79f0', name),
      field('\u914d\u7f6e\u6807\u8bc6', key, { wide: true }, h('small', null, '\u6807\u8bc6\u9700\u5305\u542b oai \u6216 claude \u53ca config\u3002\u5df2\u6709\u914d\u7f6e\u7684\u6807\u8bc6\u4e0d\u53ef\u4fee\u6539\u3002')),
      field('\u6a21\u578b ID', model),
      field('\u4e0a\u4e0b\u6587\u7a97\u53e3', ctxwin),
      field('API Base URL', base, { wide: true }, h('small', null, '\u652f\u6301 ${ENV_NAME} \u73af\u5883\u53d8\u91cf\u5f15\u7528\u3002')),
      field('API Key', secret, { wide: true }, secretHint)),
    err,
    h('div', { class: 'model-actions' }, removeBtn, saveBtn));
  const dlg = h('dialog', { class: 'gah-dialog gah-model-dialog', 'aria-label': '\u6a21\u578b\u914d\u7f6e',
      oncancel: e => { if (working) e.preventDefault(); }, onclose: () => { secret.value = ''; } },
    h('div', { class: 'dialog-head' }, h('h2', null, '\u6a21\u578b\u914d\u7f6e'), closeBtn),
    h('div', { class: 'dialog-content' },
      h('p', { class: 'model-help' }, '\u914d\u7f6e\u4fdd\u5b58\u5728\u672c\u673a\uff0c\u4e0d\u4f1a\u56de\u663e\u5df2\u6709\u7684 API Key\u3002\u4fdd\u5b58\u6210\u529f\u540e\u5373\u65f6\u751f\u6548\u3002'),
      h('div', { class: 'model-picker' }, entry, addBtn), reason, form));
  function error(t) { err.textContent = t || ''; err.hidden = !t; }
  function render(s) {
    const m = s && s.models; group.hidden = !m; if (!m) return;
    pick.replaceChildren(...m.items.map(x => h('option', { value: String(x.id) }, x.name + (x.model && x.name !== x.model ? ' / ' + x.model : ''))));
    pick.value = m.current == null ? '' : String(m.current);
    controls();
  }
  function controls() {
    const s = api.state() || {}, b = busy || working, locked = b || !(cfg && cfg.writable);
    pick.disabled = b || !(s.models && s.models.items.length);
    open.disabled = b;
    for (const n of [entry, addBtn, saveBtn, name, model, ctxwin, base, secret]) n.disabled = locked;
    key.disabled = protocol.disabled = locked || editingKey !== null;
    removeBtn.disabled = locked || editingKey === null;
    closeBtn.disabled = working;
  }
  function fill(k) {
    const e = cfg && cfg.entries.find(x => x.key === k), v = (e && e.values) || {};
    editingKey = e ? e.key : null;
    entry.value = editingKey || '';
    protocol.value = editingKey && editingKey.includes('claude') ? 'claude' : 'oai';
    key.value = editingKey || 'native_oai_config_' + Date.now();
    name.value = v.name ?? ''; model.value = v.model ?? ''; base.value = v.apibase ?? ''; ctxwin.value = v.context_win ?? '';
    const has = !!(e && e.has_key);
    secret.value = ''; secret.required = !has; secret.placeholder = has ? '******' : '';
    secretHint.textContent = has ? '\u7559\u7a7a\u4fdd\u7559\u539f\u5bc6\u94a5\u6216\u73af\u5883\u53d8\u91cf\u5f15\u7528\u3002' : '\u586b\u5199\u5bc6\u94a5\u6216 ${ENV_NAME}\u3002';
    error(e && e.url_hidden ? '\u539f URL \u542b\u654f\u611f\u4fe1\u606f\u5df2\u9690\u85cf\uff0c\u8bf7\u91cd\u65b0\u586b\u5199\u4e0d\u542b\u5bc6\u94a5\u7684 URL\u3002' : '');
    controls();
  }
  function fillConfig(preferred) {
    entry.replaceChildren(h('option', { value: '' }, '\u65b0\u589e\u914d\u7f6e'),
      ...cfg.entries.map(x => h('option', { value: x.key }, x.values.name || x.values.model || x.key)));
    reason.textContent = cfg.reason || ''; reason.hidden = !!cfg.writable;
    fill(preferred === null ? null : (cfg.entries.some(x => x.key === preferred) ? preferred : (cfg.entries[0] && cfg.entries[0].key)));
  }
  function begin() { working = true; api.lock(true); controls(); }
  function end() { working = false; api.lock(false); controls(); }
  async function select(id) {
    if (busy || working) return;
    begin(); api.notice('');
    try { api.setState(await api.host.post('/api/models/select', { id })); }
    catch (e) { api.notice(e.message); render(api.state()); }
    finally { end(); }
  }
  async function openDialog() {
    cfg = null; editingKey = null; error(''); secret.value = '';
    dlg.showModal(); begin();
    try { cfg = await api.host.get('/api/models/config'); fillConfig(); }
    catch (e) { error(e.message); }
    finally { end(); }
  }
  async function change(action) {
    if (working || busy || !(cfg && cfg.writable)) return;
    const k = key.value.trim(), body = { action, key: k, revision: cfg.revision };
    if (action === 'save') {
      body.values = { name: name.value.trim(), model: model.value.trim(), apibase: base.value.trim(), apikey: secret.value };
      if (ctxwin.value) body.values.context_win = Number(ctxwin.value);
    }
    begin(); error('');
    try {
      const d = await api.host.post('/api/models/config', body);
      cfg = d.config; api.setState(d.state); fillConfig(action === 'save' ? k : undefined);
      api.notice('\u6a21\u578b\u914d\u7f6e\u5df2\u4fdd\u5b58\u5e76\u751f\u6548');
    } catch (e) { error(e.message); }
    finally { end(); }
  }
  api.onHost('state', render);
  api.onHost('sync', d => { busy = !!d.running || (!!d.changing && !working); controls(); });
  api.slot('toolbar', group);
  api.slot('overlay', dlg);
  render(api.state());
  return () => { if (dlg.open) dlg.close(); };
});
