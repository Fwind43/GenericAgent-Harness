GAH.define('web-workspaces', api => {
  const { h } = api;
  let busy = false, saving = false, editing = null;
  const select = h('select', { 'aria-label': '项目', onchange: () => change({ action: 'select', id: select.value }) });
  const path = h('button', { type: 'button', class: 'gah-ws-path', onclick: () => open('workspace') });
  const create = h('button', { type: 'button', onclick: () => open('create'), title: '新建项目', 'aria-label': '新建项目' }, '+');
  const edit = h('button', { type: 'button', onclick: () => open('update'), title: '项目规则与笔记', 'aria-label': '项目规则与笔记' }, '设置');
  const box = h('section', { class: 'gah-workspaces', hidden: true },
    h('div', { class: 'gah-ws-label' }, '工作区 / 项目'),
    h('div', { class: 'gah-ws-picker' }, select, create, edit), path);
  const title = h('h2');
  const help = h('p', { class: 'gah-ws-help' });
  const name = h('input', { name: 'name', maxlength: '120', autocomplete: 'off' });
  const directory = h('input', { name: 'workspace', required: true, autocomplete: 'off', spellcheck: false });
  const projectId = h('input', { name: 'project_id', readonly: true, spellcheck: false });
  const rules = h('textarea', { name: 'rules', maxlength: '16000', rows: '5' });
  const memory = h('textarea', { name: 'memory', maxlength: '16000', rows: '5' });
  const field = (label, control) => h('label', { class: 'gah-ws-field' }, h('span', {}, label), control);
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

  function render(state) {
    const scope = state && state.scope;
    box.hidden = !scope;
    if (!scope) return;
    select.replaceChildren(h('option', { value: '' }, '普通工作区'),
      ...scope.projects.map(p => h('option', { value: p.id }, p.name)));
    select.value = scope.project_id || '';
    path.textContent = scope.workspace;
    path.title = scope.workspace + (scope.project_id ? ' · 项目目录固定，点击查看设置' : ' · 点击切换目录');
    edit.hidden = !scope.project_id;
    sync(busy);
  }
  function sync(value) {
    busy = value;
    for (const element of box.querySelectorAll('button,select')) element.disabled = busy;
    save.disabled = busy;
    cancel.disabled = saving;
  }
  function open(action) {
    if (busy) return;
    const scope = api.state().scope;
    if (action === 'workspace' && scope.project) action = 'update';
    const project = action === 'update' ? scope.project : null;
    if (action === 'update' && !project) return;
    editing = { action, ...(project ? { id: project.id, updated: project.updated } : {}) };
    title.textContent = action === 'workspace' ? '切换工作区' : action === 'create' ? '新建项目' : '项目设置';
    help.textContent = action === 'workspace'
      ? '使用已存在的服务器目录，并开启新会话。旧会话保留原目录和历史。工作区不是权限沙箱。'
      : '项目共享目录、规则和笔记，各会话历史独立。内容在每次模型请求时注入；笔记由你在此维护，不会自动总结。';
    nameField.hidden = rulesField.hidden = memoryField.hidden = action === 'workspace';
    name.required = action !== 'workspace';
    name.value = project ? project.name : '';
    projectIdField.hidden = !project;
    projectId.value = project ? project.id : '';
    directory.value = project ? project.workspace : scope.workspace;
    directory.readOnly = action === 'update';
    rules.value = project ? project.rules : '';
    memory.value = project ? project.memory : '';
    error.textContent = '';
    save.textContent = action === 'workspace' ? '开启新会话' : action === 'create' ? '创建并进入' : '保存';
    dialog.showModal();
    (action === 'workspace' ? directory : name).focus();
  }
  async function submit(event) {
    event.preventDefault();
    if (busy || !editing) return;
    const body = { ...editing, workspace: directory.value, name: name.value, rules: rules.value, memory: memory.value };
    saving = true;
    error.textContent = '';
    if (await change(body, true)) dialog.close();
    saving = false;
    sync(busy);
  }
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
  api.onHost('state', render);
  api.onHost('sync', value => sync(value.running || value.changing));
  api.slot('sidebar', box);
  render(api.state());
  sync(!!api.state().running);
});
