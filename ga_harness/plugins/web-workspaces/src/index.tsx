import { useEffect, useState, type KeyboardEvent, type FormEvent } from 'react';
import { host, useHost, T, type PluginAPI, type HostState, Modal, PluginSlot, Icon, useOperation, defineReact } from '@gah/sdk';

type Action = 'workspace' | 'create' | 'update';
type Edit = { action: Action; id?: string; workspace: string; name: string; updated?: number };
type Suggestion = { label: string; hint: string; fill?: string; run?: () => void };
export function Workspaces({ api }: { api: PluginAPI }) {
  const { state } = useHost(), { busy, working, run } = useOperation(api, !!state.parallel_runs), scope = state.scope;
  const [editing, setEditing] = useState<Edit | null>(null), [error, setError] = useState('');
  const [draft, setDraft] = useState(''), [focused, setFocused] = useState(false), [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Projects and workspaces are separate: a project's directory is only the default
  // for its new chats, so it is optional on create and editable afterwards.
  const open = (action: Action, id?: string) => {
    if (busy || !scope) return;
    const p = id ? scope.projects.find(item => item.id === id) : scope.project;
    if (action === 'workspace' && p && !id) { open('update'); return; }
    if (action === 'update' && !p) return;
    setError(''); setDismissed(true);
    if (action === 'update' && p) setEditing({ action, id: p.id, name: p.name, workspace: p.workspace, updated: p.updated });
    else setEditing({ action, name: '', workspace: action === 'workspace' ? scope.workspace ?? '' : '' });
  };
  async function change(body: object, inDialog = false) {
    return run(async () => {
      const previous = api.state().session_id;
      const next = await api.post<HostState>('', body); api.setState(next, next.session_id !== previous);
    }, inDialog ? setError : api.notice);
  }
  const enter = (body: object = {}) => { void change({ action: 'enter', ...body }); };
  const exits = ['off', 'exit', 'none', T('\u9000\u51fa', 'Leave').toLowerCase()];
  useEffect(() => api.listen(window, 'gah:workspace-dialog', event => {
    const detail = (event as CustomEvent<{ action?: Action; id?: string }>).detail;
    open(detail?.action === 'update' || detail?.action === 'workspace' ? detail.action : 'create', detail?.id);
  }), [api, busy, scope]);
  useEffect(() => api.onHost<string>('composer-draft', value => { setDraft(value); setActive(0); setDismissed(false); }), [api]);
  useEffect(() => api.onHost<boolean>('composer-focus', setFocused), [api]);
  useEffect(() => api.intercept(text => {
    const match = /^\/(project|workspace)(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (!match || !scope) return false;
    const cmd = match[1].toLowerCase(), arg = (match[2] || '').trim();
    if (!arg) open(cmd === 'workspace' ? 'workspace' : scope.project ? 'update' : 'create');
    else if (exits.includes(arg.toLowerCase())) enter();
    else if (cmd === 'workspace') enter({ workspace: arg });
    else if (arg.toLowerCase() === 'new') open('create');
    else {
      const matches = scope.projects.filter(p => p.name.toLowerCase().startsWith(arg.toLowerCase()));
      const project = scope.projects.find(p => p.id === arg || p.name.toLowerCase() === arg.toLowerCase()) ?? (matches.length === 1 ? matches[0] : undefined);
      if (!project) throw new Error(T('\u6ca1\u6709\u627e\u5230\u9879\u76ee\uff1a', 'Project not found: ') + arg + ' (/project new)');
      enter({ id: project.id });
    }
    return true;
  }), [api, busy, scope]);
  const suggestions: Suggestion[] = [];
  const match = /^\/(\S*)(?:\s+([\s\S]*))?$/.exec(draft);
  if (match && scope && focused && !busy && !dismissed) {
    const cmd = match[1].toLowerCase(), arg = (match[2] || '').trim(), q = arg.toLowerCase();
    if (match[2] === undefined && !/\s$/.test(draft)) {
      suggestions.push(...[{ label: '/project', hint: T('\u8fdb\u5165\u9879\u76ee', 'Enter project'), fill: '/project ' }, { label: '/workspace', hint: T('\u5207\u6362\u5de5\u4f5c\u76ee\u5f55', 'Switch directory'), fill: '/workspace ' }].filter(item => item.label.startsWith('/' + cmd)));
    } else if (cmd === 'project') {
      suggestions.push(...scope.projects.filter(p => !q || p.name.toLowerCase().includes(q)).map(p => ({ label: p.name, hint: p.id === scope.project_id ? T('\u5f53\u524d', 'Current') : p.workspace, run: () => enter({ id: p.id }) })));
      if (!q || '\u65b0\u5efa'.includes(q) || 'new'.startsWith(q)) suggestions.push({ label: T('\u65b0\u5efa\u9879\u76ee', 'New project'), hint: 'new', run: () => open('create') });
      if (scope.project && (!q || exits.some(exit => exit.startsWith(q)))) suggestions.push({ label: T('\u9000\u51fa\u9879\u76ee', 'Leave project'), hint: 'off', run: () => enter() });
    } else if (cmd === 'workspace') {
      suggestions.push(q ? { label: T('\u8fdb\u5165 ', 'Enter ') + arg, hint: T('\u76ee\u5f55', 'Directory'), run: () => enter({ workspace: arg }) } : { label: T('\u9009\u62e9\u76ee\u5f55', 'Choose directory'), hint: scope.workspace ?? '', run: () => open('workspace') });
      if (scope.project || !q) suggestions.push({ label: T('\u9000\u51fa\u5230\u9ed8\u8ba4\u5de5\u4f5c\u533a', 'Back to default workspace'), hint: 'off', run: () => enter() });
    }
  }
  const selected = Math.min(active, Math.max(0, suggestions.length - 1));
  const pick = (index: number) => { const item = suggestions[index]; if (!item) return; host.emit('draft', item.fill ?? ''); if (!item.fill) { setDismissed(true); item.run?.(); } };
  useEffect(() => api.onHost<KeyboardEvent<HTMLTextAreaElement>>('composer-key', event => {
    if (!suggestions.length || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setActive((selected + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
    else if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) pick(selected);
    else if (event.key === 'Escape') setDismissed(true);
    else return;
    event.preventDefault(); event.stopPropagation();
  }), [api, suggestions, selected]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!editing || busy) return;
    setError('');
    const body = editing.action === 'workspace' ? { action: 'enter', workspace: editing.workspace } : editing;
    if (await change(body, true)) setEditing(null);
  }
  const field = (key: 'name' | 'workspace', value: string) => setEditing(old => old ? { ...old, [key]: value } : null);
  return <><PluginSlot api={api} name="composer-top"><div className="gah-scope-bar">
    {scope && !state.messages.length && !state.running && <label className="gah-scope-pick" title={T('\u53d1\u9001\u7b2c\u4e00\u6761\u6d88\u606f\u524d\u53ef\u4ee5\u66f4\u6539', 'Can be changed until the first message is sent')}><Icon name="folder" /><span>{T('\u9879\u76ee', 'Project')}</span><select value={scope.project_id ?? ''} disabled={busy} aria-label={T('\u65b0\u5bf9\u8bdd\u6240\u5c5e\u9879\u76ee', 'Project for this new chat')} onChange={event => enter({ id: event.target.value })}><option value="">{T('\u672a\u7ed1\u5b9a\u9879\u76ee', 'No project')}</option>{scope.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
    {!!suggestions.length && <div className="gah-slash" role="listbox" aria-label={T('\u547d\u4ee4', 'Command')}>{suggestions.map((item, index) => <div key={`${item.label}:${index}`} className={`gah-slash-item${index === selected ? ' active' : ''}`} role="option" aria-selected={index === selected} onMouseDown={event => { event.preventDefault(); pick(index); }}><span>{item.label}</span><small>{item.hint}</small></div>)}</div>}
  </div></PluginSlot>
  {editing && <Modal className="gah-ws-dialog" label={T('\u5de5\u4f5c\u533a\u4e0e\u9879\u76ee\u8bbe\u7f6e', 'Workspace and project settings')} busy={working} onClose={() => setEditing(null)}>
    <form onSubmit={submit}><h2>{editing.action === 'workspace' ? T('\u5207\u6362\u5de5\u4f5c\u76ee\u5f55', 'Switch directory') : editing.action === 'create' ? T('\u65b0\u5efa\u9879\u76ee', 'New project') : T('\u9879\u76ee\u8bbe\u7f6e', 'Project settings')}</h2>
      <p className="gah-ws-help">{editing.action === 'workspace' ? T('\u4f7f\u7528\u670d\u52a1\u5668\u5df2\u5b58\u5728\u7684\u76ee\u5f55\u3002\u7a7a\u5bf9\u8bdd\u539f\u5730\u5207\u6362\uff0c\u6709\u5386\u53f2\u65f6\u65b0\u5f00\u5bf9\u8bdd\u3002\u5de5\u4f5c\u533a\u4e0d\u662f\u6743\u9650\u6c99\u7bb1\u3002', 'Use an existing server directory. Empty chats switch in place; chats with history open a new chat. A workspace is not a permission sandbox.') : T('\u9879\u76ee\u662f\u957f\u671f\u8eab\u4efd\uff0c\u8bb0\u5fc6\u6309\u540d\u79f0\u4fdd\u5b58\u5728 GA \u7684 temp/projects/<\u540d\u79f0>/\u3002\u76ee\u5f55\u53ea\u662f\u65b0\u4f1a\u8bdd\u7684\u9ed8\u8ba4\u5de5\u4f5c\u533a\uff0c\u4fee\u6539\u540e\u5df2\u6709\u4f1a\u8bdd\u4e0d\u53d8\u3002', 'A project is a durable identity; its memory lives in GA\'s temp/projects/<name>/. The directory is only the default for new chats; changing it leaves existing chats untouched.')}</p>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {editing.action !== 'workspace' && <label className="gah-ws-field"><span>{T('\u540d\u79f0', 'Name')}</span><input name="name" required maxLength={120} autoFocus value={editing.name} onChange={event => field('name', event.target.value)} /></label>}
        {editing.id && <label className="gah-ws-field"><span>ID</span><input name="project_id" readOnly value={editing.id} /></label>}
        <label className="gah-ws-field"><span>{editing.action === 'workspace' ? T('\u670d\u52a1\u5668\u4e0a\u7684\u7edd\u5bf9\u76ee\u5f55', 'Absolute directory on the server') : T('\u9ed8\u8ba4\u5de5\u4f5c\u76ee\u5f55\uff08\u53ef\u9009\uff09', 'Default directory (optional)')}</span><input name="workspace" required={editing.action === 'workspace'} autoFocus={editing.action === 'workspace'} placeholder={editing.action === 'workspace' ? '' : `${T('\u53ef\u7559\u7a7a\uff0c\u4f7f\u7528\u5168\u5c40\u9ed8\u8ba4\u5de5\u4f5c\u533a', 'Optional; uses the global default workspace')}${scope?.default_workspace ? ': ' + scope.default_workspace : ''}`} value={editing.workspace} onChange={event => field('workspace', event.target.value)} /></label>
      </fieldset>
      <div className="gah-ws-error" role="alert">{error}</div><div className="gah-ws-actions"><button type="button" disabled={working} onClick={() => setEditing(null)}>{T('\u53d6\u6d88', 'Cancel')}</button><button type="submit" className="gah-ws-save" disabled={busy}>{editing.action === 'workspace' ? T('\u8fdb\u5165\u5de5\u4f5c\u533a', 'Enter workspace') : editing.action === 'create' ? T('\u521b\u5efa\u5e76\u8fdb\u5165', 'Create and enter') : T('\u4fdd\u5b58', 'Save')}</button></div>
    </form></Modal>}
  </>;
}

defineReact('web-workspaces', Workspaces);
