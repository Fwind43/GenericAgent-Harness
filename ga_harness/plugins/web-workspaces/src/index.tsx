import { useEffect, useState, type KeyboardEvent, type FormEvent } from 'react';
import { host, useHost, T, type PluginAPI, type HostState, Modal, PluginSlot, useOperation, defineReact } from '@gah/sdk';

type Action = 'workspace' | 'create' | 'update';
type Edit = { action: Action; id?: string; workspace: string; name: string; rules: string; memory: string };
type Suggestion = { label: string; hint: string; fill?: string; run?: () => void };
export function Workspaces({ api }: { api: PluginAPI }) {
  const { state } = useHost(), { busy, working, run } = useOperation(api, !!state.parallel_runs), scope = state.scope;
  const [editing, setEditing] = useState<Edit | null>(null), [error, setError] = useState('');
  const [draft, setDraft] = useState(''), [focused, setFocused] = useState(false), [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const open = (action: Action) => {
    if (busy || !scope) return;
    const p = scope.project;
    if (action === 'workspace' && p) { open('update'); return; }
    if (action === 'update' && !p) return;
    setError(''); setDismissed(true);
    setEditing({ action, id: action === 'update' ? p?.id : undefined, name: action === 'update' ? p?.name ?? '' : '', workspace: scope.workspace ?? '', rules: action === 'update' ? p?.rules ?? '' : '', memory: action === 'update' ? p?.memory ?? '' : '' });
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
    const action = (event as CustomEvent<{ action?: Action }>).detail?.action;
    open(action === 'update' || action === 'workspace' ? action : 'create');
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
  const field = (key: 'name' | 'workspace' | 'rules' | 'memory', value: string) => setEditing(old => old ? { ...old, [key]: value } : null);
  return <><PluginSlot api={api} name="composer-top"><div className="gah-scope-bar">
    {!!suggestions.length && <div className="gah-slash" role="listbox" aria-label={T('\u547d\u4ee4', 'Command')}>{suggestions.map((item, index) => <div key={`${item.label}:${index}`} className={`gah-slash-item${index === selected ? ' active' : ''}`} role="option" aria-selected={index === selected} onMouseDown={event => { event.preventDefault(); pick(index); }}><span>{item.label}</span><small>{item.hint}</small></div>)}</div>}
    {scope && <div className={`gah-scope${scope.project ? ' in-project' : ''}`}>
      <span className="gah-scope-kind">{scope.project ? T('\u9879\u76ee', 'Project') : T('\u5de5\u4f5c\u533a', 'Workspace')}</span>
      {scope.project && <span className="gah-scope-name">{scope.project.name}</span>}
      <button type="button" className="gah-ws-path" disabled={busy} title={scope.workspace} onClick={() => open('workspace')}>{scope.workspace}</button>
      {scope.project && <><button type="button" className="gah-scope-btn" disabled={busy} onClick={() => open('update')}>{T('\u8bbe\u7f6e', 'Settings')}</button><button type="button" className="gah-scope-btn" disabled={busy} onClick={() => enter()}>{T('\u9000\u51fa', 'Leave')}</button></>}
    </div>}
  </div></PluginSlot>
  {editing && <Modal className="gah-ws-dialog" label={T('\u5de5\u4f5c\u533a\u4e0e\u9879\u76ee\u8bbe\u7f6e', 'Workspace and project settings')} busy={working} onClose={() => setEditing(null)}>
    <form onSubmit={submit}><h2>{editing.action === 'workspace' ? T('\u5207\u6362\u5de5\u4f5c\u76ee\u5f55', 'Switch directory') : editing.action === 'create' ? T('\u65b0\u5efa\u9879\u76ee', 'New project') : T('\u9879\u76ee\u8bbe\u7f6e', 'Project settings')}</h2>
      <p className="gah-ws-help">{editing.action === 'workspace' ? T('\u4f7f\u7528\u670d\u52a1\u5668\u5df2\u5b58\u5728\u7684\u76ee\u5f55\u3002\u7a7a\u5bf9\u8bdd\u539f\u5730\u5207\u6362\uff0c\u6709\u5386\u53f2\u65f6\u65b0\u5f00\u5bf9\u8bdd\u3002\u5de5\u4f5c\u533a\u4e0d\u662f\u6743\u9650\u6c99\u7bb1\u3002', 'Use an existing server directory. Empty chats switch in place; chats with history open a new chat. A workspace is not a permission sandbox.') : T('\u9879\u76ee\u5171\u4eab\u76ee\u5f55\u3001\u89c4\u5219\u548c\u7b14\u8bb0\uff0c\u5bf9\u8bdd\u5386\u53f2\u72ec\u7acb\u3002\u89c4\u5219\u4e0e\u7b14\u8bb0\u6bcf\u6b21\u8bf7\u6c42\u6ce8\u5165\uff0c\u7b14\u8bb0\u9700\u624b\u52a8\u7ef4\u62a4\u3002', 'Projects share a directory, rules and notes; chat histories stay separate. Rules and notes are injected into each request; notes are maintained manually.')}</p>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {editing.action !== 'workspace' && <label className="gah-ws-field"><span>{T('\u540d\u79f0', 'Name')}</span><input name="name" required maxLength={120} autoFocus value={editing.name} onChange={event => field('name', event.target.value)} /></label>}
        {editing.id && <label className="gah-ws-field"><span>ID</span><input name="project_id" readOnly value={editing.id} /></label>}
        <label className="gah-ws-field"><span>{T('\u670d\u52a1\u5668\u4e0a\u7684\u7edd\u5bf9\u76ee\u5f55', 'Absolute directory on the server')}</span><input name="workspace" required autoFocus={editing.action === 'workspace'} readOnly={editing.action === 'update'} value={editing.workspace} onChange={event => field('workspace', event.target.value)} /></label>
        {editing.action !== 'workspace' && <>{(['rules', 'memory'] as const).map(key => <label key={key} className="gah-ws-field"><span>{key === 'rules' ? T('\u9879\u76ee\u89c4\u5219', 'Project rules') : T('\u9879\u76ee\u7b14\u8bb0', 'Project notes')}</span><textarea name={key} rows={5} value={editing[key]} onChange={event => field(key, event.target.value)} /></label>)}</>}
      </fieldset>
      <div className="gah-ws-error" role="alert">{error}</div><div className="gah-ws-actions"><button type="button" disabled={working} onClick={() => setEditing(null)}>{T('\u53d6\u6d88', 'Cancel')}</button><button type="submit" className="gah-ws-save" disabled={busy}>{editing.action === 'workspace' ? T('\u8fdb\u5165\u5de5\u4f5c\u533a', 'Enter workspace') : editing.action === 'create' ? T('\u521b\u5efa\u5e76\u8fdb\u5165', 'Create and enter') : T('\u4fdd\u5b58', 'Save')}</button></div>
    </form></Modal>}
  </>;
}

defineReact('web-workspaces', Workspaces);
