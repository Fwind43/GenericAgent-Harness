GAH.define('web-workspaces', api => {
  // Conversation-level scope: the chip above the composer shows the current
  // conversation's project/workspace; /project and /workspace switch it.
  // Entering a scope binds an empty conversation in place, otherwise opens a new one.
  const { h } = api;
  let busy = false, saving = false, editing = null, items = [], active = 0;
  const input = document.getElementById('input');
  const composer = document.getElementById('form');

  // ---- sidebar: project list ----
  const create = h('button', { type: 'button', class: 'gah-ws-add', onclick: () => open('create'), title: '新建项目', 'aria-label': '新建项目' }, '+');
  const list = h('div', { class: 'gah-ws-list', role: 'list', 'aria-label': '项目列表' });
  const box = h('section', { class: 'gah-workspaces', hidden: true },
    h('div', { class: 'gah-ws-head' }, h('span', { class: 'gah-ws-label' }, '项目'), create), list);

  // ---- composer chip ----
  const kind = h('span', { class: 'gah-scope-kind' });
  const label = h('span', { class: 'gah-scope-name' });
  const path = h('button', { type: 'button', class: 'gah-ws-path', onclick: () => open('workspace') });
  const edit = h('button', { type: 'button', class: 'gah-scope-btn', onclick: () => open('update'), title: '项目规则与笔记', 'aria-label': '项目规则与笔记' }, '设置');
  const leave = h('button', { type: 'button', class: 'gah-scope-btn', onclick: () => enter({}), title: '退出到普通对话', 'aria-label': '退出项目' }, '退出');
  const chip = h('div', { class: 'gah-scope', hidden: true }, kind, label, path, edit, leave);
  const menu = h('div', { class: 'gah-slash', role: 'listbox', hidden: true, 'aria-label': '命令' });
  const top = h('div', { class: 'gah-scope-bar' }, menu, chip);

  // ---- dialog ----
  const title = h('h2');
  const help = h('p', { class: 'gah-ws-help' });
  const name = h('input', { name: 'name', maxlength: '120', autocomplete: 'off' });
  const directory = h('input', { name: 'workspace', required: true, autocomplete: 'off', spellcheck: false });
  const projectId = h('input', { name: 'project_id', readonly: true, spellcheck: false });
  const rules = h('textarea', { name: 'rules', maxlength: '16000', rows: '5' });
  const memory = h('textarea', { name: 'memory', maxlength: '16000', rows: '5' });
  const field = (text, control) => h('label', { class: 'gah-ws-field' }, h('span', {}, text), control);
  const nameField = field('项目名称', name);
  const projectIdField = field('项目 ID（可选中复制，用于 --project）', projectId);
  const rulesField = field('共享规则', rules);
  const memoryField = field('共享笔记', memory);
  const error = h('p', { class: 'gah-ws-error', role: 'alert' });
  const cancel = h('button', { type: 'button', onclick: () => dialog.close() }, '取消');
  const save = h('button', { type: 'submit', class: 'gah-ws-save' }, '保存');
  const form = h('form', { onsubmit: submit }, title, help, nameField, projectIdField, field('服务器上的绝对目录', directory),
    rulesField, memoryField, error, h('div', { class: 'gah-ws-actions' }, cancel, save));
  const dialog = h('dialog', { class: 'gah-ws-dialog', 'aria-label': '工作区与项目设置' }, form);
  document.body.append(dialog);
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  api.cleanup(() => dialog.remove());

  const scope = () => (api.state() || {}).scope;
  function render(state) {
    const s = state && state.scope;
    box.hidden = chip.hidden = !s;
    if (!s) return;
    list.replaceChildren(...s.projects.map(p => {
      const cur = p.id === s.project_id;
      return h('div', { class: 'gah-ws-row' + (cur ? ' current' : ''), role: 'listitem' },
        h('button', { type: 'button', class: 'gah-ws-open', 'data-gah-close': '', title: p.workspace, 'aria-current': cur ? 'true' : null,
          onclick: () => { if (!cur) enter({ id: p.id }); } }, h('span', { class: 'gah-ws-dot', 'aria-hidden': 'true' }), h('span', { class: 'gah-ws-title' }, p.name)));
    }));
    if (!s.projects.length) list.append(h('div', { class: 'gah-ws-empty' }, '输入 /project 新建或进入项目'));
    chip.classList.toggle('in-project', !!s.project);
    kind.textContent = s.project ? '项目' : '工作区';
    label.textContent = s.project ? s.project.name : '';
    label.hidden = !s.project;
    path.textContent = s.workspace;
    path.title = s.workspace + (s.project ? ' · 项目目录固定，点击查看设置' : ' · 点击切换目录（/workspace）');
    edit.hidden = leave.hidden = !s.project;
    sync(busy);
  }
  function sync(value) {
    busy = value;
    for (const element of [...box.querySelectorAll('button'), ...chip.querySelectorAll('button')]) element.disabled = busy;
    save.disabled = busy;
    cancel.disabled = saving;
  }
  function open(action) {
    if (busy) return;
    const s = scope();
    if (!s) return;
    if (action === 'workspace' && s.project) action = 'update';
    const project = action === 'update' ? s.project : null;
    if (action === 'update' && !project) return;
    editing = { action, ...(project ? { id: project.id, updated: project.updated } : {}) };
    title.textContent = action === 'workspace' ? '切换工作区' : action === 'create' ? '新建项目' : '项目设置';
    help.textContent = action === 'workspace'
      ? '使用已存在的服务器目录。空对话直接切换，已有记录的对话会新开一个，旧对话保留原目录和历史。工作区不是权限沙箱。'
      : '项目共享目录、规则和笔记，各对话历史独立。内容在每次模型请求时注入；笔记由你在此维护，不会自动总结。';
    nameField.hidden = rulesField.hidden = memoryField.hidden = action === 'workspace';
    name.required = action !== 'workspace';
    name.value = project ? project.name : '';
    projectIdField.hidden = !project;
    projectId.value = project ? project.id : '';
    directory.value = project ? project.workspace : s.workspace;
    directory.readOnly = action === 'update';
    rules.value = project ? project.rules : '';
    memory.value = project ? project.memory : '';
    error.textContent = '';
    save.textContent = action === 'workspace' ? '进入工作区' : action === 'create' ? '创建并进入' : '保存';
    dialog.showModal();
    (action === 'workspace' ? directory : name).focus();
  }
  async function submit(event) {
    event.preventDefault();
    if (busy || !editing) return;
    const body = editing.action === 'workspace'
      ? { action: 'enter', workspace: directory.value }
      : { ...editing, workspace: directory.value, name: name.value, rules: rules.value, memory: memory.value };
    saving = true;
    error.textContent = '';
    if (await change(body, true)) dialog.close();
    saving = false;
    sync(busy);
  }
  const enter = body => change({ action: 'enter', ...body });
  async function change(body, inDialog = false) {
    if (busy) return false;
    api.lock(true);
    api.notice('');
    try {
      const previous = api.state().session_id;
      const next = await api.post('', body);
      api.setState(next, next.session_id !== previous);
      return true;
    } catch (e) {
      if (inDialog) error.textContent = e.message;
      else api.notice(e.message);
      render(api.state());
      return false;
    } finally { api.lock(false); }
  }

  // ---- slash commands ----
  const EXIT = ['off', 'exit', 'none', '退出'];
  function find(arg) {
    const s = scope(), q = arg.toLowerCase();
    const ps = (s && s.projects) || [];
    return ps.find(p => p.id === arg || p.name.toLowerCase() === q)
      || (ps.filter(p => p.name.toLowerCase().startsWith(q)).length === 1 ? ps.find(p => p.name.toLowerCase().startsWith(q)) : null);
  }
  function suggest(text) {
    const m = /^\/(\S*)(?:\s+([\s\S]*))?$/.exec(text);
    if (!m) return [];
    const cmd = m[1].toLowerCase(), arg = m[2];
    const s = scope();
    if (!s) return [];
    if (arg === undefined && !/\s$/.test(text)) {
      return [
        { label: '/project', hint: '进入项目（本对话）', fill: '/project ' },
        { label: '/workspace', hint: '切换工作目录（本对话）', fill: '/workspace ' },
      ].filter(x => x.label.startsWith('/' + cmd));
    }
    const q = (arg || '').trim().toLowerCase();
    if (cmd === 'project') {
      const out = s.projects.filter(p => !q || p.name.toLowerCase().includes(q))
        .map(p => ({ label: p.name, hint: p.id === s.project_id ? '当前' : p.workspace, run: () => enter({ id: p.id }) }));
      if (!q || '新建'.includes(q) || 'new'.startsWith(q)) out.push({ label: '新建项目…', hint: 'new', run: () => open('create') });
      if (s.project && (!q || EXIT.some(x => x.startsWith(q)))) out.push({ label: '退出项目', hint: 'off', run: () => enter({}) });
      return out;
    }
    if (cmd === 'workspace') {
      const out = [];
      if (q) out.push({ label: '进入 ' + arg.trim(), hint: '目录', run: () => enter({ workspace: arg.trim() }) });
      else out.push({ label: '选择目录…', hint: s.workspace, run: () => open('workspace') });
      if (s.project || !q) out.push({ label: '退出到默认工作区', hint: 'off', run: () => enter({}) });
      return out;
    }
    return [];
  }
  function show(text) {
    items = busy ? [] : suggest(text);
    active = Math.min(active, Math.max(items.length - 1, 0));
    menu.hidden = !items.length;
    menu.replaceChildren(...items.map((x, i) => h('div', { class: 'gah-slash-item' + (i === active ? ' active' : ''), role: 'option',
      'aria-selected': i === active ? 'true' : 'false', onmousedown: e => { e.preventDefault(); pick(i); } },
      h('span', { class: 'gah-slash-label' }, x.label), h('span', { class: 'gah-slash-hint' }, x.hint || ''))));
  }
  function clearInput() { input.value = ''; input.dispatchEvent(new Event('input')); }
  function pick(i) {
    const x = items[i];
    if (!x) return;
    if (x.fill) { input.value = x.fill; input.dispatchEvent(new Event('input')); input.focus(); return; }
    clearInput(); menu.hidden = true; items = [];
    x.run();
  }
  function onInput() { active = 0; show(input.value); }
  function onKey(e) {
    if (menu.hidden || !items.length || e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; show(input.value);
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      pick(active);
    } else if (e.key === 'Escape') {
      menu.hidden = true; items = [];
    } else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }
  input.addEventListener('input', onInput);
  input.addEventListener('blur', () => { menu.hidden = true; });
  input.addEventListener('focus', onInput);
  composer.addEventListener('keydown', onKey, true);
  api.cleanup(() => { input.removeEventListener('input', onInput); input.removeEventListener('focus', onInput); composer.removeEventListener('keydown', onKey, true); });
  api.intercept(text => {
    const m = /^\/(project|workspace)(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (!m) return false;
    const cmd = m[1].toLowerCase(), arg = (m[2] || '').trim();
    if (!arg) { cmd === 'project' ? open(scope() && scope().project ? 'update' : 'create') : open('workspace'); return true; }
    if (EXIT.includes(arg.toLowerCase())) { enter({}); return true; }
    if (cmd === 'workspace') { enter({ workspace: arg }); return true; }
    if (arg.toLowerCase() === 'new') { open('create'); return true; }
    const p = find(arg);
    if (!p) throw new Error('没有找到项目：' + arg + '（输入 /project new 新建）');
    enter({ id: p.id });
    return true;
  });

  api.onHost('state', render);
  api.onHost('sync', value => { sync(value.running || value.changing); if (busy) menu.hidden = true; });
  api.slot('sidebar', box);
  api.slot('composer-top', top);
  render(api.state());
  sync(!!(api.state() && api.state().running));
});
