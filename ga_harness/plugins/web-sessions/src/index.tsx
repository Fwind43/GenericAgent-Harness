import { useEffect, useRef, useState } from 'react';
import { type PluginAPI, type HostState, type Session, useHost, saved, save, T, Icon, PluginSlot, useOperation, defineReact } from '@gah/sdk';

type Group = { key: string; kind: string; name: string; path: string; body: { id?: string; workspace?: string }; items: Session[] };
const base = (path = '') => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
const scopeKey = (state: HostState) => state.scope?.project_id ? `p:${state.scope.project_id}` : `w:${state.scope?.workspace ?? ''}`;
function groupSessions(state: HostState) {
  const groups = new Map<string, Group>(), scope = state.scope;
  if (!scope) return [];
  const get = (group: Group) => { if (!groups.has(group.key)) groups.set(group.key, group); return groups.get(group.key)!; };
  const projectGroup = (p: typeof scope.projects[number]): Group => ({ key: `p:${p.id}`, kind: 'project', name: p.name, path: p.workspace, body: { id: p.id }, items: [] });
  const workspaceGroup = (path = ''): Group => ({ key: `w:${path}`, kind: 'workspace', name: base(path), path, body: { workspace: path }, items: [] });
  for (const session of state.sessions ?? []) {
    const project = scope.projects.find(p => p.id === session.project_id);
    get(project ? projectGroup(project) : workspaceGroup(session.workspace)).items.push(session);
  }
  scope.projects.forEach(p => get(projectGroup(p)));
  if (!scope.project_id) get(workspaceGroup(scope.workspace));
  return [...groups.values()];
}
export function Sessions({ api }: { api: PluginAPI }) {
  const { state } = useHost(), { busy, run } = useOperation(api, !!state.parallel_runs);
  const [toggled, setToggled] = useState<Record<string, boolean>>(() => {
    try { const value: unknown = JSON.parse(saved('gah.sessions.groups') ?? '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, boolean> : {}; } catch { return {}; }
  });
  const current = scopeKey(state), previous = useRef(current);
  useEffect(() => {
    if (previous.current !== current) { previous.current = current; setToggled(old => { const next = { ...old }; delete next[current]; return next; }); }
  }, [current]);
  const change = (path: string, body: object, reset: boolean) => run(async () => {
    const next = await api.host.post<HostState>(path, body); api.setState(next, reset);
  });
  const act = (action: string, extra: object = {}) => change('/api/sessions', { action, id: state.session_id, ...extra }, ['new', 'open', 'delete', 'clear'].includes(action));
  const row = (session: Session) => <div key={session.id} className={`gah-sess-row${session.id === state.session_id ? ' current' : ''}`} role="listitem">
    <button type="button" className="gah-sess-open" disabled={busy} data-gah-close="" onClick={() => void act('open', { id: session.id })} title={session.title}><span className="gah-sess-title">{session.title === '\u65b0\u4f1a\u8bdd' ? T('\u65b0\u4f1a\u8bdd', 'New chat') : session.title || T('\u65b0\u4f1a\u8bdd', 'New chat')}</span></button>
    <span className="gah-sess-acts"><button type="button" className="gah-sess-act" disabled={busy} aria-label={T('\u91cd\u547d\u540d', 'Rename')} onClick={() => { const title = prompt(T('\u4f1a\u8bdd\u540d\u79f0', 'Chat name'), session.title); if (title?.trim()) void act('rename', { id: session.id, title: title.trim() }); }}><Icon name="pencil" /></button>
      <button type="button" className="gah-sess-act" disabled={busy} aria-label={T('\u5220\u9664', 'Remove')} onClick={() => { if (confirm(T('\u4ece\u5217\u8868\u5220\u9664\u6b64\u4f1a\u8bdd\uff1f\u5386\u53f2\u8bb0\u5f55\u4fdd\u7559\u5728\u672c\u5730\u6570\u636e\u5e93\u3002', 'Remove this chat from the list? History stays in the local database.'))) void act('delete', { id: session.id }); }}><Icon name="trash" /></button></span>
  </div>;
  return <PluginSlot api={api} name="sidebar"><div className="gah-sessions" hidden={!state.sessions}>
    <button type="button" className="side-item gah-sess-new" disabled={busy} data-gah-close="" onClick={() => void act('new')}><Icon name="pen" />{T('\u65b0\u4f1a\u8bdd', 'New chat')}</button>
    <div className="gah-sess-label"><span>{T('\u4f1a\u8bdd', 'Chat')}</span>{state.scope && <button type="button" className="gah-sess-head-btn" disabled={busy} aria-label={T('\u65b0\u5efa\u9879\u76ee', 'New project')} onClick={() => window.dispatchEvent(new CustomEvent('gah:workspace-dialog', { detail: { action: 'create' } }))}><Icon name="folder-plus" /></button>}</div>
    <div className="gah-sess-list" aria-label={T('\u4f1a\u8bdd\u5217\u8868', 'Chats')}>
      {state.scope ? groupSessions(state).map(group => {
        const isCurrent = group.key === current, open = toggled[group.key] ?? isCurrent;
        return <section key={group.key} className={`gah-group ${group.kind}${isCurrent ? ' current' : ''}`} data-key={group.key}>
          <div className="gah-group-head"><button type="button" className="gah-group-toggle" title={group.path} aria-expanded={open} onClick={() => setToggled(old => { const next = { ...old, [group.key]: !open }; save('gah.sessions.groups', JSON.stringify(next)); return next; })}><span className="gah-ico gah-ico-closed" data-i="folder" aria-hidden="true" /><span className="gah-ico gah-ico-open" data-i="folder-open" aria-hidden="true" /><span className="gah-group-name">{group.name}</span></button>
            <button type="button" className="gah-group-add" disabled={busy} data-gah-close="" aria-label={`${T('\u65b0\u5efa\u5bf9\u8bdd', 'New chat')}: ${group.name}`} onClick={() => void (isCurrent ? act('new') : change('/api/p/web-workspaces/', { action: 'enter', ...group.body }, true))}><Icon name="plus" /></button></div>
          <div className="gah-sess-items" role="list" hidden={!open}>{group.items.length ? group.items.map(row) : <div className="gah-sess-empty">{T('\u6682\u65e0\u4f1a\u8bdd', 'No chats yet')}</div>}</div>
        </section>;
      }) : state.sessions?.map(row)}
    </div></div></PluginSlot>;
}

defineReact('web-sessions', Sessions);
