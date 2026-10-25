GAH.define('web-workspaces', api => {
  // Conversation-level scope: the chip above the composer shows the current
  // conversation's project/workspace; /project and /workspace switch it.
  // Entering a scope binds an empty conversation in place, otherwise opens a new one.
  const { h } = api;
  let busy = false, saving = false, editing = null, items = [], active = 0;
  const input = document.getElementById('input');
  const composer = document.getElementById('form');

  // The sidebar project/workspace groups live in web-sessions; it asks for dialogs via this event.
  api.listen(window, 'gah:workspace-dialog', e => open((e.detail && e.detail.action) || 'create'));

  // ---- composer chip ----
  const kind = h('span', { class: 'gah-scope-kind' });
  const label = h('span', { class: 'gah-scope-name' });
  const path = h('button', { type: 'button', class: 'gah-ws-path', onclick: () => open('workspace') });
  const edit = h('button', { type: 'button', class: 'gah-scope-btn', onclick: () => open('update'), title: T('项目规则与笔记','Project rules and notes'), 'aria-label': T('项目规则与笔记','Project rules and notes') }, T('设置','Settings'));
  const leave = h('button', { type: 'button', class: 'gah-scope-btn', onclick: () => enter({}), title: T('退出到普通对话','Back to a normal chat'), 'aria-label': T('退出项目','Leave project') }, T('退出','Leave'));
  const chip = h('div', { class: 'gah-scope', hidden: true }, kind, label, path, edit, leave);
  const menu = h('div', { class: 'gah-slash', role: 'listbox', hidden: true, 'aria-label': T('命令','Command') });
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
  const nameField = field(T('项目名称','Project name'), name);
  const projectIdField = field(T('项目 ID（可选中复制，用于 --project）','Project ID (select to copy, for --project)'), projectId);
  const rulesField = field(T('共享规则','Shared rules'), rules);
  const memoryField = field(T('共享笔记','Shared notes'), memory);
  const error = h('p', { class: 'gah-ws-error', role: 'alert' });
  const cancel = h('button', { type: 'button', onclick: () => dialog.close() }, T('取消','Cancel'));
  const save = h('button', { type: 'submit', class: 'gah-ws-save' }, T('保存','Save'));
  const form = h('form', { onsubmit: submit }, title, help, nameField, projectIdField, field(T('服务器上的绝对目录','Absolute directory on the server'), directory),
    rulesField, memoryField, error, h('div', { class: 'gah-ws-actions' }, cancel, save));
  const dialog = h('dialog', { class: 'gah-ws-dialog', 'aria-label': T('工作区与项目设置','Workspace and project settings') }, form);
  document.body.append(dialog);
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  api.cleanup(() => dialog.remove());

  const scope = () => (api.state() || {}).scope;
  function render(state) {
    const s = state && state.scope;
    chip.hidden = !s;
    if (!s) return;
    chip.classList.toggle('in-project', !!s.project);
    kind.textContent = s.project ? T('项目','Project') : T('工作区','Workspace');
    label.textContent = s.project ? s.project.name : '';
    label.hidden = !s.project;
    path.textContent = s.workspace;
    path.title = s.workspace + (s.project ? T(' · 项目目录固定，点击查看设置',' · project directory is fixed; click for settings') : T(' · 点击切换目录（/workspace）',' · click to switch directory (/workspace)'));
    edit.hidden = leave.hidden = !s.project;
    sync(busy);
  }
  function sync(value) {
    busy = value;
    for (const element of chip.querySelectorAll('button')) element.disabled = busy;
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
    title.textContent = action === 'workspace' ? T('切换工作区','Switch workspace') : action === 'create' ? T('新建项目','New project') : T('项目设置','Project settings');
    help.textContent = action === 'workspace'
      ? T('使用已存在的服务器目录。空对话直接切换，已有记录的对话会新开一个，旧对话保留原目录和历史。工作区不是权限沙箱。','Uses an existing directory on the server. An empty chat switches in place; a chat with history opens a new chat and the old one keeps its directory and history. A workspace is not a permission sandbox.')
      : T('项目共享目录、规则和笔记，各对话历史独立。内容在每次模型请求时注入；笔记由你在此维护，不会自动总结。','Chats in a project share its directory, rules and notes, but keep separate histories. Rules and notes are injected into every model request; notes are maintained by you here and never summarized automatically.');
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
    save.textContent = action === 'workspace' ? T('进入工作区','Enter workspace') : action === 'create' ? T('创建并进入','Create and enter') : T('保存','Save');
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
  const EXIT = ['off', 'exit', 'none', T('退出','Leave')];
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
        { label: '/project', hint: T('进入项目（本对话）','Enter project (this chat)'), fill: '/project ' },
        { label: '/workspace', hint: T('切换工作目录（本对话）','Switch directory (this chat)'), fill: '/workspace ' },
      ].filter(x => x.label.startsWith('/' + cmd));
    }
    const q = (arg || '').trim().toLowerCase();
    if (cmd === 'project') {
      const out = s.projects.filter(p => !q || p.name.toLowerCase().includes(q))
        .map(p => ({ label: p.name, hint: p.id === s.project_id ? T('当前','Current') : p.workspace, run: () => enter({ id: p.id }) }));
      if (!q || '新建'.includes(q) || 'new'.startsWith(q)) out.push({ label: T('新建项目…','New project…'), hint: 'new', run: () => open('create') });
      if (s.project && (!q || EXIT.some(x => x.startsWith(q)))) out.push({ label: T('退出项目','Leave project'), hint: 'off', run: () => enter({}) });
      return out;
    }
    if (cmd === 'workspace') {
      const out = [];
      if (q) out.push({ label: T('进入 ','Enter ') + arg.trim(), hint: T('目录','Directory'), run: () => enter({ workspace: arg.trim() }) });
      else out.push({ label: T('选择目录…','Choose directory…'), hint: s.workspace, run: () => open('workspace') });
      if (s.project || !q) out.push({ label: T('退出到默认工作区','Back to default workspace'), hint: 'off', run: () => enter({}) });
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
    if (!p) throw new Error(T('没有找到项目：','Project not found: ') + arg + T('（输入 /project new 新建）',' (type /project new to create one)'));
    enter({ id: p.id });
    return true;
  });

  api.onHost('state', render);
  api.onHost('sync', value => { sync(value.running || value.changing); if (busy) menu.hidden = true; });
  api.slot('composer-top', top);
  render(api.state());
  sync(!!(api.state() && api.state().running));
});
