import { useEffect, useRef, useState } from 'react';
import { type PluginAPI, type HostState, type Session, useHost, saved, save, T, Icon, confirmDialog, promptDialog, PluginSlot, useOperation, defineReact } from '@gah/sdk';

// Sidebar layout: projects first (each a collapsible group of its chats), then the
// chats that belong to no project. A project is a durable identity; the workspace is
// only a per-chat directory, shown as a tag when it differs from the group default.
const RECENT = 5, NEW = '\u65b0\u4f1a\u8bdd';
const base = (path = '') => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
const label = (s: Session) => !s.title || s.title === NEW ? T(NEW, 'New chat') : s.title;
const loadToggles = (): Record<string, boolean> => {
  try { const value: unknown = JSON.parse(saved('gah.sessions.groups') ?? '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, boolean> : {}; } catch { return {}; }
};
// Children follow their parent inside the same group; orphans (parent elsewhere) stay top level.
function nest(items: Session[]) {
  const ids = new Set(items.map(s => s.id)), kids = new Map<string, Session[]>(), seen = new Set<string>();
  for (const s of items) if (s.parent_id && s.parent_id !== s.id && ids.has(s.parent_id)) kids.set(s.parent_id, [...(kids.get(s.parent_id) ?? []), s]);
  const out: { session: Session; depth: number }[] = [];
  const walk = (s: Session, depth: number) => { if (seen.has(s.id)) return; seen.add(s.id); out.push({ session: s, depth }); for (const k of kids.get(s.id) ?? []) walk(k, Math.min(depth + 1, 3)); };
  for (const s of items) if (!s.parent_id || !ids.has(s.parent_id)) walk(s, 0);
  for (const s of items) walk(s, 0); // cycle safety: nothing is ever dropped
  return out;
}
export function Sessions({ api }: { api: PluginAPI }) {
  const { state } = useHost(), { busy, run } = useOperation(api, !!state.parallel_runs);
  const [toggled, setToggled] = useState(loadToggles), [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState(''), [moving, setMoving] = useState('');
  const scope = state.scope, projects = scope?.projects ?? [];
  const current = scope?.project_id ? `p:${scope.project_id}` : 'recent', previous = useRef(current);
  useEffect(() => {
    if (previous.current !== current) { previous.current = current; setToggled(old => { const next = { ...old }; delete next[current]; return next; }); }
  }, [current]);
  const change = (path: string, body: object, reset: boolean) => run(async () => {
    const next = await api.host.post<HostState>(path, body); api.setState(next, reset);
  });
  const act = (action: string, extra: object = {}) => change('/api/sessions', { action, id: state.session_id, ...extra }, ['new', 'select', 'delete', 'clear'].includes(action));
  const scoped = (body: object, reset = true) => change('/api/p/web-workspaces/', body, reset);
  const dialog = (action: string, id?: string) => window.dispatchEvent(new CustomEvent('gah:workspace-dialog', { detail: { action, id } }));
  const toggle = (key: string, open: boolean) => setToggled(old => { const next = { ...old, [key]: !open }; save('gah.sessions.groups', JSON.stringify(next)); return next; });
  const activity = new Map<string, string>();
  for (const item of state.runs ?? []) if (item.status === 'running' || item.status === 'cancelling') activity.set(item.session_id, item.status);
  if (state.running && state.session_id && !activity.has(state.session_id)) activity.set(state.session_id, 'running');
  const q = query.trim().toLowerCase();
  const known = new Set(projects.map(p => p.id)), byProject = new Map<string, Session[]>(), loose: Session[] = [];
  for (const s of state.sessions ?? []) {
    if (q && !label(s).toLowerCase().includes(q) && !(s.workspace ?? '').toLowerCase().includes(q)) continue;
    if (s.project_id && known.has(s.project_id)) byProject.set(s.project_id, [...(byProject.get(s.project_id) ?? []), s]); else loose.push(s);
  }
  const row = (session: Session, depth: number, home?: string) => {
    const status = activity.get(session.id), tag = session.workspace && session.workspace !== home ? base(session.workspace) : '';
    return <div key={session.id} className={`gah-sess-row${session.id === state.session_id ? ' current' : ''}${status ? ' running' : ''}${depth ? ' child' : ''}`} style={depth ? { paddingLeft: depth * 14 } : undefined} role="listitem">
      <button type="button" className="gah-sess-open" disabled={busy} data-gah-close="" onClick={() => void act('select', { id: session.id })} title={session.workspace ? `${label(session)}\n${session.workspace}` : label(session)}>
        <span className="gah-sess-title">{label(session)}</span>{tag && <span className="gah-sess-tag">{tag}</span>}
        {status && <span className={`gah-sess-status ${status}`} role="status" title={status === 'cancelling' ? T('\u6b63\u5728\u505c\u6b62', 'Stopping') : T('\u8fd0\u884c\u4e2d', 'Running')} aria-label={status === 'cancelling' ? T('\u6b63\u5728\u505c\u6b62', 'Stopping') : T('\u8fd0\u884c\u4e2d', 'Running')} />}</button>
      <span className="gah-sess-acts">
        <button type="button" className="gah-sess-act" disabled={busy} aria-label={T('\u91cd\u547d\u540d', 'Rename')} onClick={async () => { const title = await promptDialog({ title: T('\u91cd\u547d\u540d\u4f1a\u8bdd', 'Rename chat'), placeholder: T('\u4f1a\u8bdd\u540d\u79f0', 'Chat name'), value: session.title, confirm: T('\u4fdd\u5b58', 'Save') }); if (title?.trim()) void act('rename', { id: session.id, title: title.trim() }); }}><Icon name="pencil" /></button>
        <button type="button" className="gah-sess-act" disabled={busy || !!status} aria-label={T('\u79fb\u52a8\u5230\u9879\u76ee', 'Move to project')} aria-expanded={moving === session.id} onClick={() => setMoving(moving === session.id ? '' : session.id)}><Icon name="folder" /></button>
        <button type="button" className="gah-sess-act" disabled={busy} aria-label={T('\u5220\u9664', 'Remove')} onClick={async () => { if (await confirmDialog({ title: T('\u5220\u9664\u4f1a\u8bdd', 'Remove chat'), danger: true, confirm: T('\u5220\u9664', 'Remove'), message: T('\u4ece\u5217\u8868\u5220\u9664\u6b64\u4f1a\u8bdd\uff1f\u5386\u53f2\u8bb0\u5f55\u4fdd\u7559\u5728\u672c\u5730\u6570\u636e\u5e93\u3002', 'Remove this chat from the list? History stays in the local database.') })) void act('delete', { id: session.id }); }}><Icon name="trash" /></button></span>
      {moving === session.id && <select className="gah-sess-move" autoFocus aria-label={T('\u79fb\u52a8\u5230\u9879\u76ee', 'Move to project')} value={session.project_id && known.has(session.project_id) ? session.project_id : ''}
        onKeyDown={event => { if (event.key === 'Escape') setMoving(''); }} onBlur={() => setMoving('')}
        onChange={event => { const target = event.target.value; setMoving(''); void scoped({ action: 'move', session_id: session.id, project_id: target }, false); }}>
        <option value="">{T('\u65e0\u9879\u76ee', 'No project')}</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
    </div>;
  };
  // Long groups show the latest few (plus the open chat); searching always shows every match.
  const list = (key: string, items: Session[], home?: string) => {
    const rows = nest(items), all = !!q || !!expanded[key];
    const shown = all ? rows : rows.filter((r, i) => i < RECENT || r.session.id === state.session_id);
    return <div className="gah-sess-items" role="list">
      {rows.length ? shown.map(r => row(r.session, r.depth, home)) : <div className="gah-sess-empty">{q ? T('\u65e0\u5339\u914d\u4f1a\u8bdd', 'No matching chats') : T('\u6682\u65e0\u4f1a\u8bdd', 'No chats yet')}</div>}
      {!q && rows.length > RECENT && <button type="button" className="gah-sess-more" onClick={() => setExpanded(old => ({ ...old, [key]: !all }))}>{all ? T('\u6536\u8d77', 'Show less') : `${T('\u663e\u793a\u5168\u90e8', 'Show all')} (${rows.length})`}</button>}
    </div>;
  };
  const projectGroups = projects.map(p => {
    const key = `p:${p.id}`, items = byProject.get(p.id) ?? [];
    if (q && !items.length && !p.name.toLowerCase().includes(q)) return null;
    const isCurrent = key === current, open = q ? true : toggled[key] ?? isCurrent;
    return <section key={key} className={`gah-group project${isCurrent ? ' current' : ''}`} data-key={key}>
      <div className="gah-group-head"><button type="button" className="gah-group-toggle" title={p.workspace} aria-expanded={open} onClick={() => toggle(key, open)}><span className="gah-ico gah-ico-closed" data-i="folder" aria-hidden="true" /><span className="gah-ico gah-ico-open" data-i="folder-open" aria-hidden="true" /><span className="gah-group-name">{p.name}</span><span className="gah-group-count">{(byProject.get(p.id) ?? []).length}</span></button>
        <button type="button" className="gah-group-add" disabled={busy} data-gah-close="" aria-label={`${T('\u65b0\u5efa\u5bf9\u8bdd', 'New chat')}: ${p.name}`} onClick={() => void (isCurrent ? act('new') : scoped({ action: 'enter', id: p.id }))}><Icon name="plus" /></button>
        <button type="button" className="gah-group-add" disabled={busy} aria-label={`${T('\u9879\u76ee\u8bbe\u7f6e', 'Project settings')}: ${p.name}`} onClick={() => dialog('update', p.id)}><Icon name="pencil" /></button>
        <button type="button" className="gah-group-add" disabled={busy} aria-label={`${T('\u5220\u9664\u9879\u76ee', 'Delete project')}: ${p.name}`} onClick={async () => { if (await confirmDialog({ title: T('\u5220\u9664\u9879\u76ee', 'Delete project'), danger: true, confirm: T('\u5220\u9664', 'Delete'), message: T('\u5220\u9664\u9879\u76ee\u201c', 'Delete project "') + p.name + T('\u201d\uff1f\u5176\u4e2d\u7684\u4f1a\u8bdd\u4f1a\u79fb\u5230\u201c\u6700\u8fd1\u201d\uff0c\u9879\u76ee\u8bb0\u5fc6\u6587\u4ef6\u4fdd\u7559\u5728\u78c1\u76d8\u4e0a\u3002', '"? Its chats move to Recent; the project memory files stay on disk.') })) void scoped({ action: 'delete', id: p.id }, isCurrent); }}><Icon name="trash" /></button></div>
      {open && list(key, items, p.workspace || scope?.default_workspace)}
    </section>;
  });
  return <PluginSlot api={api} name="sidebar"><div className="gah-sessions" hidden={!state.sessions}>
    <button type="button" className="side-item gah-sess-new" disabled={busy} title={scope?.project ? `${T('\u5728\u9879\u76ee\u4e2d\u65b0\u5efa', 'New chat in')}: ${scope.project.name}` : T('\u65b0\u5efa\u672a\u7ed1\u5b9a\u9879\u76ee\u7684\u5bf9\u8bdd', 'New chat without a project')} data-gah-close="" onClick={() => void act('new')}><Icon name="pen" />{T('\u65b0\u4f1a\u8bdd', 'New chat')}</button>
    <input type="search" className="gah-sess-search" value={query} placeholder={T('\u641c\u7d22\u4f1a\u8bdd', 'Search chats')} aria-label={T('\u641c\u7d22\u4f1a\u8bdd', 'Search chats')} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setQuery(''); }} />
    <div className="gah-sess-list" aria-label={T('\u4f1a\u8bdd\u5217\u8868', 'Chats')}>
      {scope ? <>
        <div className="gah-sess-label"><span>{T('\u9879\u76ee', 'Projects')}</span><button type="button" className="gah-sess-head-btn" disabled={busy} aria-label={T('\u65b0\u5efa\u9879\u76ee', 'New project')} onClick={() => dialog('create')}><Icon name="folder-plus" /></button></div>
        {projects.length ? projectGroups : <div className="gah-sess-empty">{T('\u8fd8\u6ca1\u6709\u9879\u76ee', 'No projects yet')}</div>}
        <div className="gah-sess-label"><span>{T('\u6700\u8fd1', 'Recent')}</span><button type="button" className="gah-sess-head-btn" disabled={busy} data-gah-close="" aria-label={T('\u65b0\u5efa\u5bf9\u8bdd', 'New chat')} onClick={() => void (current === 'recent' ? act('new') : scoped({ action: 'enter' }))}><Icon name="plus" /></button></div>
        <section className={`gah-group recent${current === 'recent' ? ' current' : ''}`} data-key="recent">{list('recent', loose, scope.project_id ? undefined : scope.workspace)}</section>
      </> : <div className="gah-sess-items flat" role="list">{(state.sessions ?? []).filter(s => !q || label(s).toLowerCase().includes(q)).map(s => row(s, 0))}</div>}
    </div></div></PluginSlot>;
}

defineReact('web-sessions', Sessions);
