GAH.define('web-models', api => {
  const { h } = api;
  let cfg = null, editingKey = null, busy = false, working = false;
  let sections = [], sectionId = null;
  const field = (label, input, extra = {}, hint) => h('label', { class: 'model-field' + (extra.wide ? ' wide' : '') }, label, input, hint || null);
  /* ---- one composer entry for model + per-conversation effort ---- */
  const EFFORT_LABEL = { '': T('\u9ed8\u8ba4','Default'), low: T('\u4f4e','Low'), medium: T('\u4e2d','Medium'), high: T('\u9ad8','High'), xhigh: T('\u8d85\u9ad8','Extra high') };
  const pickName = h('span', { class: 'gah-model-name' });
  const pickEffort = h('span', { class: 'gah-model-effort' });
  const pick = h('button', { type: 'button', class: 'gah-model-trigger', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    'aria-controls': 'gah-model-picker', onclick: () => togglePicker() }, pickName, pickEffort,
    h('span', { class: 'gah-model-caret', 'aria-hidden': 'true' }, '\u2303'));
  const group = h('div', { class: 'gah-models', hidden: true }, pick);
  const effortChoices = h('div', { class: 'gah-effort-options', role: 'group', 'aria-label': T('\u63a8\u7406\u5f3a\u5ea6','Reasoning effort') });
  const effortBox = h('div', { class: 'gah-picker-effort' },
    h('div', { class: 'gah-picker-label' }, T('\u63a8\u7406\u5f3a\u5ea6','Reasoning effort'),
      h('small', null, T('\u4ec5\u5f53\u524d\u5bf9\u8bdd','This chat only'))), effortChoices);
  const pickerModels = h('div', { class: 'gah-picker-models' });
  const picker = h('div', { id: 'gah-model-picker', class: 'gah-model-popover', popover: 'auto', role: 'dialog',
    'aria-label': T('\u6a21\u578b\u4e0e\u63a8\u7406\u5f3a\u5ea6','Model and reasoning effort'),
    ontoggle: () => { pick.setAttribute('aria-expanded', String(picker.matches(':popover-open'))); },
    onkeydown: e => pickerKeys(e) }, effortBox, pickerModels);
  const open = h('button', { type: 'button', class: 'side-item', 'data-gah-close': '', onclick: () => openDialog(), hidden: true },
    h('span', { class: 'gah-ico', dataset: { i: 'cpu' }, 'aria-hidden': 'true' }), T('\u6a21\u578b\u914d\u7f6e','Models'));
  function positionPicker() {
    if (!picker.matches(':popover-open')) return;
    const r = pick.getBoundingClientRect(), w = picker.offsetWidth, height = picker.offsetHeight;
    picker.style.left = Math.max(12, Math.min(r.right - w, innerWidth - w - 12)) + 'px';
    picker.style.top = Math.max(12, Math.min(r.top - height - 8, innerHeight - height - 12)) + 'px';
  }
  function closePicker(focus = false) {
    if (!picker.matches(':popover-open')) return;
    picker.hidePopover(); pick.setAttribute('aria-expanded', 'false');
    if (focus) pick.focus();
  }
  function togglePicker() {
    if (pick.disabled) return;
    if (picker.matches(':popover-open')) return closePicker(true);
    picker.showPopover(); positionPicker(); pick.setAttribute('aria-expanded', 'true');
    (pickerModels.querySelector('[aria-pressed="true"]') || pickerModels.querySelector('button'))?.focus();
  }
  function pickerKeys(e) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const buttons = [...picker.querySelectorAll('button:not(:disabled)')], i = buttons.indexOf(document.activeElement);
    if (i < 0 || !buttons.length) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }
  window.addEventListener('resize', positionPicker);
  /* ---- dialog ---- */
  const addBtn = h('button', { type: 'button', onclick: () => newModel() }, T('\u65b0\u589e\u6a21\u578b','Add model'));
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
  const prov = h('select', { 'aria-label': T('\u6240\u5c5e\u670d\u52a1\u5546','Provider'), onchange: () => provChanged() });
  const baseField = field('API Base URL', base, { wide: true }, h('small', null, T('\u652f\u6301 ${ENV_NAME} \u73af\u5883\u53d8\u91cf\u5f15\u7528\u3002','Supports ${ENV_NAME} environment variable references.')));
  const secretField = field('API Key', secret, { wide: true }, secretHint);
  /* ---- provider form ---- */
  const paddBtn = h('button', { type: 'button', class: 'secondary', onclick: () => editProvider(null) }, T('\u65b0\u589e\u670d\u52a1\u5546','Add provider'));
  const pid = h('input', { required: true, pattern: '[a-z0-9][a-z0-9_\\-]{0,39}', autocomplete: 'off', placeholder: 'openai' });
  const pname = h('input', { maxlength: '120', autocomplete: 'off' });
  const pproto = h('select', null, h('option', { value: 'oai' }, 'OpenAI compatible'), h('option', { value: 'claude' }, 'Anthropic Claude'));
  const pbase = h('input', { required: true, autocomplete: 'off', placeholder: 'https://api.openai.com/v1' });
  const psecret = h('input', { type: 'password', autocomplete: 'new-password' });
  const psecretHint = h('small');
  const perr = h('p', { class: 'gah-error', role: 'status', hidden: true });
  let editingPid = null;
  const pDelBtn = h('button', { type: 'button', class: 'secondary', onclick: () => {
    if (confirm(T('\u5220\u9664\u6b64\u670d\u52a1\u5546\uff1f\u5176\u4e0b\u4ecd\u6709\u6a21\u578b\u65f6\u4e0d\u80fd\u5220\u9664\u3002','Delete this provider? Providers that still have models cannot be deleted.'))) pchange('provider_delete'); } }, T('\u5220\u9664\u670d\u52a1\u5546','Delete provider'));
  const pSaveBtn = h('button', { type: 'submit' }, T('\u4fdd\u5b58\u670d\u52a1\u5546','Save provider'));
  const pform = h('form', { onsubmit: e => { e.preventDefault(); pchange('provider_save'); } },
    h('div', { class: 'model-grid' },
      field(T('\u670d\u52a1\u5546\u6807\u8bc6','Provider ID'), pid, {}, h('small', null, T('\u5c0f\u5199\u5b57\u6bcd/\u6570\u5b57/-/_\uff0c\u521b\u5efa\u540e\u4e0d\u53ef\u6539\u3002','Lowercase letters, digits, - and _. Cannot be changed after creation.'))),
      field(T('\u663e\u793a\u540d\u79f0','Display name'), pname),
      field(T('\u9ed8\u8ba4\u534f\u8bae','Default protocol'), pproto),
      field('API Base URL', pbase, { wide: true }, h('small', null, T('\u652f\u6301 ${ENV_NAME} \u73af\u5883\u53d8\u91cf\u5f15\u7528\u3002','Supports ${ENV_NAME} environment variable references.'))),
      field('API Key', psecret, { wide: true }, psecretHint)),
    perr,
    h('div', { class: 'model-actions' }, pDelBtn, pSaveBtn));
  const removeBtn = h('button', { type: 'button', class: 'secondary', onclick: () => {
    if (confirm(T('\u5220\u9664\u6b64\u6a21\u578b\u914d\u7f6e\uff1f\u81f3\u5c11\u9700\u4fdd\u7559\u4e00\u4e2a\u6a21\u578b\u3002','Delete this model? At least one model must remain.'))) change('delete'); } }, T('\u5220\u9664\u914d\u7f6e','Delete model'));
  const saveBtn = h('button', { type: 'submit' }, T('\u4fdd\u5b58\u5e76\u751f\u6548','Save and apply'));
  const closeBtn = h('button', { type: 'button', class: 'secondary', onclick: () => dlg.close() }, T('\u5173\u95ed','Close'));
  const form = h('form', { onsubmit: e => { e.preventDefault(); change('save'); } },
    h('div', { class: 'model-grid' },
      field(T('\u6240\u5c5e\u670d\u52a1\u5546','Provider'), prov, { wide: true }),
      field(T('\u534f\u8bae','Protocol'), protocol),
      field(T('\u663e\u793a\u540d\u79f0','Display name'), name),
      field(T('\u914d\u7f6e\u6807\u8bc6','Config ID'), key, { wide: true }, h('small', null, T('\u6807\u8bc6\u9700\u5305\u542b oai \u6216 claude \u53ca config\u3002\u5df2\u6709\u914d\u7f6e\u7684\u6807\u8bc6\u4e0d\u53ef\u4fee\u6539\u3002','The ID must contain oai or claude, and config. Existing IDs cannot be changed.'))),
      field(T('\u6a21\u578b ID','Model ID'), model),
      field(T('\u4e0a\u4e0b\u6587\u7a97\u53e3','Context window'), ctxwin),
      baseField, secretField),
    h('div', { class: 'model-actions' }, removeBtn, saveBtn));
  const help = h('p', { class: 'model-help' }, T('\u914d\u7f6e\u4fdd\u5b58\u5728\u672c\u673a\uff0c\u4e0d\u4f1a\u56de\u663e\u5df2\u6709\u7684 API Key\u3002\u4fdd\u5b58\u6210\u529f\u540e\u5373\u65f6\u751f\u6548\u3002','Settings are stored on this machine; existing API keys are never shown. Changes apply immediately after saving.'));
  const convertBtn = h('button', { type: 'button', onclick: () => convert() }, T('\u8f6c\u6362\u4e3a\u53ef\u7f16\u8f91\u914d\u7f6e','Convert to editable config'));
  const convertBox = h('div', { class: 'model-actions model-convert', hidden: true }, convertBtn);
  const sectionList = h('nav', { class: 'model-sections', 'aria-label': T('\u670d\u52a1\u5546\u5206\u533a','Providers') });
  const sectionTitle = h('h3');
  const sectionHint = h('p', { class: 'model-help' });
  const editProviderBtn = h('button', { type: 'button', class: 'secondary', onclick: () => editProvider(currentSection()?.provider) }, T('\u670d\u52a1\u5546\u8bbe\u7f6e','Provider settings'));
  const backBtn = h('button', { type: 'button', class: 'secondary', onclick: () => selectSection(sectionId, editingKey) }, T('\u8fd4\u56de\u6a21\u578b','Back to model'));
  const modelList = h('div', { class: 'model-list', role: 'group', 'aria-label': T('\u8be5\u5206\u533a\u7684\u6a21\u578b','Models in this group') });
  const empty = h('p', { class: 'model-empty' }, T('\u6682\u65e0\u6a21\u578b\uff0c\u70b9\u51fb\u201c\u65b0\u589e\u6a21\u578b\u201d\u6dfb\u52a0\u3002','No models yet. Click “Add model” to add one.'));
  const editorTitle = h('h4', { class: 'model-editor-title' });
  const editor = h('div', { class: 'model-editor' }, editorTitle, form);
  const modelArea = h('div', { class: 'model-area' }, modelList, empty, editor);
  const sectionBody = h('section', { class: 'model-section-body' },
    h('div', { class: 'model-section-head' }, h('div', { class: 'model-section-heading' }, sectionTitle, sectionHint),
      h('div', { class: 'model-section-tools' }, backBtn, editProviderBtn, addBtn)), modelArea, pform);
  const layout = h('div', { class: 'model-layout', hidden: true },
    h('aside', { class: 'model-sidebar' }, h('div', { class: 'model-sidebar-head' }, h('strong', null, T('\u670d\u52a1\u5546','Provider')), paddBtn), sectionList), sectionBody);
  const loading = h('p', { class: 'model-help', role: 'status', hidden: true }, T('\u6b63\u5728\u52a0\u8f7d\u6a21\u578b\u914d\u7f6e\u2026','Loading models…'));
  const dlg = h('dialog', { class: 'gah-dialog gah-model-dialog', 'aria-label': T('\u6a21\u578b\u914d\u7f6e','Models'),
      oncancel: e => { if (working) e.preventDefault(); }, onclose: () => { secret.value = ''; psecret.value = ''; } },
    h('div', { class: 'dialog-head' }, h('h2', null, T('\u6a21\u578b\u914d\u7f6e','Models')), closeBtn),
    h('div', { class: 'dialog-content' }, help, reason, convertBox, loading, err, layout));
  function currentSection() { return sections.find(g => g.id === sectionId); }
  // Legacy grouping is presentation only: never merge credentials or infer a provider.
  function sectionKey(e) {
    return e.provider ? 'provider:' + e.provider : 'legacy:' + JSON.stringify([e.protocol, e.values.apibase || (e.url_hidden ? e.key : '')]);
  }
  function endpointLabel(value) {
    try { const u = new URL(value); return u.host + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')); }
    catch (_) { return value || T('\u672a\u8bbe\u7f6e API \u5730\u5740','No API URL set'); }
  }
  function buildSections() {
    const map = new Map((cfg.providers || []).map(p => ['provider:' + p.id,
      { id: 'provider:' + p.id, provider: p.id, title: p.values.name || p.id,
        hint: p.values.protocol === 'claude' ? 'Anthropic Claude' : 'OpenAI compatible', entries: [] }]));
    for (const e of cfg.entries) {
      const id = sectionKey(e);
      if (!map.has(id)) map.set(id, { id, title: e.provider || endpointLabel(e.values.apibase),
        hint: T('\u672a\u7ed1\u5b9a\u670d\u52a1\u5546 \u00b7 ','No provider · ') + (e.protocol === 'claude' ? 'Claude' : 'OpenAI'), entries: [] });
      map.get(id).entries.push(e);
    }
    sections = [...map.values()];
    sectionList.replaceChildren(...sections.map(g => h('button', { type: 'button', class: 'model-section-item',
      dataset: { section: g.id }, onclick: () => selectSection(g.id) },
      h('span', { class: 'model-section-label' }, h('strong', null, g.title), h('small', null, g.hint)),
      h('span', { class: 'model-count' }, String(g.entries.length)))));
  }
  function markSelection() {
    for (const b of sectionList.querySelectorAll('button')) b.setAttribute('aria-current', String(b.dataset.section === sectionId));
    for (const b of modelList.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.key === editingKey));
  }
  function selectSection(id, preferred) {
    sectionId = id; const g = currentSection();
    pform.hidden = true; modelArea.hidden = false; backBtn.hidden = true;
    editProviderBtn.hidden = !g?.provider; addBtn.hidden = !g;
    sectionTitle.textContent = g?.title || T('\u5148\u6dfb\u52a0\u670d\u52a1\u5546','Add a provider first');
    sectionHint.textContent = !g ? T('\u914d\u7f6e API \u5730\u5740\u548c\u5bc6\u94a5\uff0c\u518d\u6dfb\u52a0\u6240\u5c5e\u6a21\u578b\u3002','Set the API URL and key, then add its models.') : g.provider
      ? g.hint + ' \u00b7 ' + g.entries.length + T(' \u4e2a\u6a21\u578b\uff0c\u5171\u7528\u670d\u52a1\u5546\u7684 API \u914d\u7f6e',' models sharing this provider\'s API settings')
      : T('\u6309 API \u5730\u5740\u5c55\u793a\u65e7\u914d\u7f6e\uff0c\u5bc6\u94a5\u4ecd\u72ec\u7acb\u4fdd\u7559\u3002\u53ef\u5728\u6a21\u578b\u8be6\u60c5\u4e2d\u7ed1\u5b9a\u670d\u52a1\u5546\u3002','Legacy models grouped by API URL; each keeps its own key. Bind a provider in the model details.');
    const es = g?.entries || [];
    modelList.replaceChildren(...es.map(e => h('button', { type: 'button', class: 'model-list-item', dataset: { key: e.key }, onclick: () => fill(e.key) },
      h('strong', null, e.values.name || e.values.model || e.key), h('small', null, e.values.model || e.key))));
    empty.hidden = !!es.length; modelList.hidden = !es.length;
    fill(es.find(e => e.key === preferred)?.key || es[0]?.key || null);
    editor.hidden = !es.length;
    markSelection(); controls();
  }
  function newModel() {
    fill(null); const g = currentSection();
    if (g?.provider) {
      prov.value = g.provider; protocol.value = cfg.providers.find(p => p.id === g.provider)?.values.protocol || 'oai'; provChanged();
    }
    else if (g?.entries.length) {
      base.value = g.entries[0].values.apibase || ''; protocol.value = g.entries[0].protocol;
      key.value = 'native_' + protocol.value + '_config_' + Date.now();
    }
    empty.hidden = true; editor.hidden = false; name.focus();
  }
  function editProvider(id) {
    pfill(id); error(''); modelArea.hidden = true; pform.hidden = false;
    addBtn.hidden = editProviderBtn.hidden = true; backBtn.hidden = false;
    sectionTitle.textContent = id ? T('\u670d\u52a1\u5546\u8bbe\u7f6e','Provider settings') : T('\u65b0\u589e\u670d\u52a1\u5546','Add provider');
    sectionHint.textContent = T('\u914d\u7f6e\u4e00\u6b21 API \u5730\u5740\u4e0e\u5bc6\u94a5\uff0c\u4f9b\u8be5\u670d\u52a1\u5546\u4e0b\u7684\u6a21\u578b\u5171\u7528\u3002','Set the API URL and key once; all models under this provider share them.');
    if (!id) { for (const b of sectionList.querySelectorAll('button')) b.setAttribute('aria-current', 'false'); pid.focus(); }
    controls();
  }
  function error(t) { err.textContent = t || ''; err.hidden = !t; }
  function render(s) {
    const m = s && s.models; group.hidden = open.hidden = !m;
    if (!m) { closePicker(); return; }
    const current = m.items.find(x => x.id === m.current), e = s.effort;
    pickName.textContent = current?.name || current?.model || T('\u9009\u62e9\u6a21\u578b','Choose model');
    pickEffort.hidden = !e; pickEffort.textContent = e ? EFFORT_LABEL[e.current || ''] || e.current : '';
    pick.title = [current?.provider, pickName.textContent, e && T('\u63a8\u7406\u5f3a\u5ea6\uff1a','Reasoning effort: ') + pickEffort.textContent].filter(Boolean).join(' / ');
    pick.setAttribute('aria-label', T('\u6a21\u578b\u4e0e\u63a8\u7406\u5f3a\u5ea6\uff1a','Model and reasoning effort: ') + pick.title);
    effortBox.hidden = !e;
    effortChoices.replaceChildren(...(e ? ['', ...e.options].map(v => h('button', { type: 'button', dataset: { effort: v },
      'aria-pressed': String(v === (e.current || '')), onclick: () => { closePicker(true); setEffort(v); } }, EFFORT_LABEL[v] || v)) : []));
    const groups = new Map();
    for (const x of m.items) {
      const id = x.provider_id || x.provider || '';
      if (!groups.has(id)) groups.set(id, { label: x.provider || T('\u72ec\u7acb\u914d\u7f6e','Standalone'), items: [] });
      groups.get(id).items.push(x);
    }
    pickerModels.replaceChildren(...[...groups].map(([id, g]) => h('section', { class: 'gah-picker-provider', dataset: { provider: id },
      'aria-label': g.label }, h('h3', null, g.label, h('span', null, String(g.items.length))),
      ...g.items.map(x => h('button', { type: 'button', class: 'gah-picker-option', dataset: { modelId: String(x.id) },
        'aria-pressed': String(x.id === m.current), onclick: () => { closePicker(true); select(x.id); } },
        h('span', { class: 'gah-picker-option-copy' }, h('span', null, x.name || x.model),
          x.model && x.name !== x.model ? h('small', null, x.model) : null),
        h('span', { class: 'gah-picker-check', 'aria-hidden': 'true' }, x.id === m.current ? '\u2713' : ''))))));
    if (!m.items.length) pickerModels.append(h('p', { class: 'gah-picker-empty' }, T('\u6682\u65e0\u53ef\u7528\u6a21\u578b','No models available')));
    controls(); positionPicker();
  }
  function controls() {
    const s = api.state() || {}, b = busy || working, locked = b || !(cfg && cfg.writable);
    pick.disabled = b || !(s.models && s.models.items.length);
    for (const n of picker.querySelectorAll('button')) n.disabled = b;
    if (busy && !working) closePicker();
    open.disabled = b;
    convertBtn.disabled = b;
    for (const n of [addBtn, saveBtn, name, model, ctxwin, base, secret, prov, paddBtn, pSaveBtn, pname, pbase, psecret]) n.disabled = locked;
    key.disabled = locked || editingKey !== null;
    protocol.disabled = locked || editingKey !== null;
    pid.disabled = locked || editingPid !== null;
    pproto.disabled = locked;
    pDelBtn.disabled = locked || editingPid === null;
    removeBtn.disabled = locked || editingKey === null;
    closeBtn.disabled = working;
    editProviderBtn.disabled = backBtn.disabled = b;
    for (const n of [...sectionList.querySelectorAll('button'), ...modelList.querySelectorAll('button')]) n.disabled = b;
  }
  function fill(k) {
    const e = cfg && cfg.entries.find(x => x.key === k), v = (e && e.values) || {};
    editingKey = e ? e.key : null;
    editorTitle.textContent = e ? T('\u6a21\u578b\u8be6\u60c5','Model details') : T('\u65b0\u589e\u6a21\u578b','Add model');
    markSelection();
    protocol.value = editingKey && editingKey.includes('claude') ? 'claude' : 'oai';
    prov.value = (e && e.provider) || '';
    key.value = editingKey || 'native_oai_config_' + Date.now();
    name.value = v.name ?? ''; model.value = v.model ?? ''; base.value = v.apibase ?? ''; ctxwin.value = v.context_win ?? '';
    const has = !!(e && e.has_key);
    secret.value = ''; secret.required = !has; secret.placeholder = has ? '******' : '';
    secretHint.textContent = has ? T('\u7559\u7a7a\u4fdd\u7559\u539f\u5bc6\u94a5\u6216\u73af\u5883\u53d8\u91cf\u5f15\u7528\u3002','Leave empty to keep the existing key or environment variable reference.') : T('\u586b\u5199\u5bc6\u94a5\u6216 ${ENV_NAME}\u3002','Enter a key or ${ENV_NAME}.');
    provToggle();
    error(e && e.url_hidden ? T('\u539f URL \u542b\u654f\u611f\u4fe1\u606f\u5df2\u9690\u85cf\uff0c\u8bf7\u91cd\u65b0\u586b\u5199\u4e0d\u542b\u5bc6\u94a5\u7684 URL\u3002','The original URL contained sensitive data and is hidden. Enter a URL without the key.') : '');
    controls();
  }
  function provToggle() {
    const p = cfg && cfg.providers && cfg.providers.find(x => x.id === prov.value);
    baseField.hidden = secretField.hidden = !!p;
    base.required = !p; if (p) secret.required = false;
  }
  function provChanged() {
    provToggle();
    if (editingKey === null) key.value = 'native_' + protocol.value + '_config_' + Date.now();
    else if (!prov.value) { const e = cfg.entries.find(x => x.key === editingKey); secret.required = !(e && e.has_key); }
    controls();
  }
  function pfill(id) {
    const p = cfg && cfg.providers && cfg.providers.find(x => x.id === id), v = (p && p.values) || {};
    editingPid = p ? p.id : null;
    pid.value = editingPid || ''; pname.value = v.name ?? ''; pproto.value = v.protocol || 'oai'; pbase.value = v.apibase ?? '';
    const has = !!(p && p.has_key);
    psecret.value = ''; psecret.required = !has; psecret.placeholder = has ? '******' : '';
    psecretHint.textContent = has ? T('\u7559\u7a7a\u4fdd\u7559\u539f\u5bc6\u94a5\u6216\u73af\u5883\u53d8\u91cf\u5f15\u7528\u3002','Leave empty to keep the existing key or environment variable reference.') : T('\u586b\u5199\u5bc6\u94a5\u6216 ${ENV_NAME}\u3002','Enter a key or ${ENV_NAME}.');
    perror(p && p.url_hidden ? T('\u539f URL \u542b\u654f\u611f\u4fe1\u606f\u5df2\u9690\u85cf\uff0c\u8bf7\u91cd\u65b0\u586b\u5199\u3002','The original URL contained sensitive data and is hidden. Please enter it again.') : '');
    controls();
  }
  function perror(t) { perr.textContent = t || ''; perr.hidden = !t; }
  function fillConfig(preferred, ppreferred) {
    const ps = cfg.providers || [];
    prov.replaceChildren(h('option', { value: '' }, T('\u65e0\uff08\u5355\u72ec\u586b\u5199 URL / Key\uff09','None (enter URL / key separately)')),
      ...ps.map(x => h('option', { value: x.id }, (x.values.name || x.id) + ' (' + x.values.protocol + ')')));
    buildSections();
    const e = cfg.entries.find(x => x.key === preferred);
    const id = ppreferred ? 'provider:' + ppreferred : e ? sectionKey(e) : sectionId;
    selectSection(sections.some(g => g.id === id) ? id : sections[0]?.id || null, preferred);
    layout.hidden = false;
    reason.textContent = cfg.writable ? '' : readonlyText(cfg); reason.hidden = !!cfg.writable;
    help.hidden = !cfg.writable;
    convertBox.hidden = !(cfg.convert && !cfg.convert.blocked);
  }
  function readonlyText(c) {
    const t = c.convert && c.convert.target;
    if (c.reason_code === 'ga_mykey' && t && c.convert.blocked)
      return T('\u5f53\u524d\u4f7f\u7528 GA \u81ea\u5e26\u7684 mykey.py\uff0c\u7f51\u9875\u91cc\u53ea\u80fd\u67e5\u770b\u3002','Currently using GA\'s own mykey.py; it is read-only here.') + t + T(' \u5df2\u5b58\u5728\u4f46\u5c1a\u672a\u542f\u7528\uff0c\u91cd\u542f gah \u540e\u5373\u53ef\u5728\u8fd9\u91cc\u7f16\u8f91\u3002',' exists but is not active yet. Restart gah to edit it here.');
    if (c.reason_code === 'ga_mykey' && t)
      return T('\u5f53\u524d\u4f7f\u7528 GA \u81ea\u5e26\u7684 mykey.py\uff0c\u7f51\u9875\u91cc\u4e0d\u80fd\u4fee\u6539\u3002\u70b9\u51fb\u4e0b\u65b9\u6309\u94ae\u4f1a\u628a\u5b83\u590d\u5236\u5230 ','Currently using GA\'s own mykey.py, which cannot be edited here. The button below copies it to ') + t + T('\uff0c\u4ee5\u540e\u5728\u8fd9\u91cc\u7f16\u8f91\uff1b\u539f mykey.py \u4fdd\u6301\u4e0d\u53d8\uff0c\u8f6c\u6362\u540e\u7acb\u5373\u751f\u6548\u3002',' so you can edit it here. The original mykey.py stays unchanged, and the conversion applies immediately.');
    if (c.reason_code === 'ga_mykey') return T('\u5f53\u524d\u4f7f\u7528 GA \u81ea\u5e26\u7684 mykey.py\uff0c\u7f51\u9875\u91cc\u4e0d\u80fd\u4fee\u6539\u3002\u8fd0\u884c gah llm migrate \u8f6c\u6362\u540e\u5373\u53ef\u5728\u8fd9\u91cc\u7f16\u8f91\u3002','Currently using GA\'s own mykey.py, which cannot be edited here. Run gah llm migrate to make it editable.');
    if (c.reason_code === 'inline') return T('\u6a21\u578b\u914d\u7f6e\u5199\u5728 profile \u7684 keys \u91cc\uff0c\u8bf7\u76f4\u63a5\u4fee\u6539 profile\u3002','Models are defined in the profile\'s keys; edit the profile directly.');
    return T('\u914d\u7f6e\u6587\u4ef6\u6682\u65f6\u65e0\u6cd5\u7f16\u8f91\uff1a','The config file cannot be edited right now: ') + (c.reason || '');
  }
  async function convert() {
    if (working || busy || !(cfg && cfg.convert)) return;
    begin(); error('');
    try {
      const d = await api.host.post('/api/models/config', { action: 'convert' });
      cfg = d.config; api.setState(d.state); fillConfig();
      api.notice(T('\u5df2\u8f6c\u6362\u4e3a\u53ef\u7f16\u8f91\u914d\u7f6e\u5e76\u751f\u6548','Converted to an editable config and applied'));
    } catch (e) { error(e.message); }
    finally { end(); }
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
  async function setEffort(v) {
    if (busy || working) return;
    begin(); api.notice('');
    try { api.setState(await api.host.post('/api/effort', { effort: v || null })); }
    catch (e) { api.notice(e.message); render(api.state()); }
    finally { end(); }
  }
  async function openDialog() {
    closePicker();
    cfg = null; editingKey = null; error(''); secret.value = ''; psecret.value = '';
    layout.hidden = true; loading.hidden = false; reason.hidden = convertBox.hidden = true;
    dlg.showModal(); begin();
    try { cfg = await api.host.get('/api/models/config'); fillConfig(); }
    catch (e) { error(e.message); }
    finally { loading.hidden = true; end(); }
  }
  async function change(action) {
    if (working || busy || !(cfg && cfg.writable)) return;
    const k = key.value.trim(), body = { action, key: k, revision: cfg.revision };
    if (action === 'save') {
      body.values = prov.value ? { name: name.value.trim(), model: model.value.trim(), provider: prov.value }
        : { name: name.value.trim(), model: model.value.trim(), apibase: base.value.trim(), apikey: secret.value };
      if (ctxwin.value) body.values.context_win = Number(ctxwin.value);
    }
    begin(); error('');
    try {
      const d = await api.host.post('/api/models/config', body);
      cfg = d.config; api.setState(d.state); fillConfig(action === 'save' ? k : undefined);
      api.notice(T('\u6a21\u578b\u914d\u7f6e\u5df2\u4fdd\u5b58\u5e76\u751f\u6548','Model saved and applied'));
    } catch (e) { error(e.message); }
    finally { end(); }
  }
  async function pchange(action) {
    if (working || busy || !(cfg && cfg.writable)) return;
    const id = pid.value.trim(), body = { action, id, revision: cfg.revision };
    if (action === 'provider_save') body.values = { name: pname.value.trim(), protocol: pproto.value, apibase: pbase.value.trim(), apikey: psecret.value };
    begin(); perror('');
    try {
      const d = await api.host.post('/api/models/config', body);
      cfg = d.config; api.setState(d.state); fillConfig(undefined, action === 'provider_save' ? id : null);
      api.notice(T('\u670d\u52a1\u5546\u5df2\u4fdd\u5b58\u5e76\u751f\u6548','Provider saved and applied'));
    } catch (e) { perror(e.message); }
    finally { end(); }
  }
  api.onHost('state', render);
  api.onHost('sync', d => { busy = !!d.running || (!!d.changing && !working); controls(); });
  api.slot('composer', group);
  api.slot('sidebar-foot', open);
  api.slot('overlay', picker);
  api.slot('overlay', dlg);
  render(api.state());
  return () => { closePicker(); window.removeEventListener('resize', positionPicker); if (dlg.open) dlg.close(); };
});
