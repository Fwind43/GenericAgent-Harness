import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { type PluginAPI, type HostState, type Session, useHost, saved, save, T, Icon, confirmDialog, promptDialog, PluginSlot, PageNav, pages, useOperation, defineReact } from '@gah/sdk';

// Sidebar layout: projects first (each a collapsible group of its chats), then Recent:
// every chat by recency, project chats tagged with their project name. A project is a durable identity; the workspace is
// only a per-chat directory, shown as a tag when it differs from the group default.
const NEW = '\u65b0\u4f1a\u8bdd';
// Customizable sections (GA Admin style): each can be hidden, reordered, collapsed and
// capped to a display count. The Projects count caps both the project groups and the
// chats inside each group; the Recent count caps its chats. Stored per browser.
export const SECTION_COUNTS = [5, 10, 15, 20, 50, 100];
const SECTION_KEYS = ['projects', 'recent'] as const;
type SectionKey = typeof SECTION_KEYS[number];
type SectionPref = { show: boolean; open: boolean; count: number };
type Layout = { order: SectionKey[]; sections: Record<SectionKey, SectionPref> };
const LAYOUT_KEY = 'gah.sessions.layout', DEFAULT_COUNT: Record<SectionKey, number> = { projects: 5, recent: 10 };
const sectionName = (key: SectionKey) => key === 'projects' ? T('\u9879\u76ee', 'Projects') : T('\u6700\u8fd1', 'Recent');
export function normalizeLayout(value?: unknown): Layout {
  const raw = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as { order?: unknown; sections?: Record<string, Partial<SectionPref> | undefined> };
  const valid = Array.isArray(raw.order) ? [...new Set(raw.order.filter((k): k is SectionKey => SECTION_KEYS.includes(k as SectionKey)))] : [];
  const order = [...valid, ...SECTION_KEYS.filter(k => !valid.includes(k))];
  const sections = Object.fromEntries(SECTION_KEYS.map(k => {
    const old = raw.sections && typeof raw.sections === 'object' ? raw.sections[k] ?? {} : {};
    return [k, { show: typeof old.show === 'boolean' ? old.show : true, open: typeof old.open === 'boolean' ? old.open : true,
      count: SECTION_COUNTS.includes(Number(old.count)) ? Number(old.count) : DEFAULT_COUNT[k] }];
  })) as Record<SectionKey, SectionPref>;
  return { order, sections };
}
const loadLayout = (): Layout => { try { return normalizeLayout(JSON.parse(saved(LAYOUT_KEY) ?? '{}')); } catch { return normalizeLayout(); } };
const base = (path = '') => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
const label = (s: Session) => !s.title || s.title === NEW ? T(NEW, 'New chat') : s.title;
// Compact relative age for the row ("3m", "2h", "5d", then a date) so chats with the
// same title stay distinguishable at a glance; the full timestamp lives in the tooltip.
const ago = (ts?: number) => {
  if (!ts) return '';
  const secs = Math.max(0, Date.now() / 1000 - ts);
  if (secs < 60) return T('\u521a\u521a', 'now');
  if (secs < 3600) return Math.floor(secs / 60) + T('\u5206', 'm');
  if (secs < 86400) return Math.floor(secs / 3600) + T('\u5c0f\u65f6', 'h');
  if (secs < 86400 * 7) return Math.floor(secs / 86400) + T('\u5929', 'd');
  const d = new Date(ts * 1000); return `${d.getMonth() + 1}/${d.getDate()}`;
};
const stamp = (ts?: number) => ts ? new Date(ts * 1000).toLocaleString() : '';
const loadToggles = (): Record<string, boolean> => {
  try { const value: unknown = JSON.parse(saved('gah.sessions.groups') ?? '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, boolean> : {}; } catch { return {}; }
};
// Children follow their parent inside the same group; orphans (parent elsewhere) stay top level.
function nest(items: Session[]) {
  const ids = new Set(items.map(s => s.id)), kids = new Map<string, Session[]>(), seen = new Set<string>();
  for (const s of items) if (s.parent_id && s.parent_id !== s.id && ids.has(s.parent_id)) kids.set(s.parent_id, [...(kids.get(s.parent_id) ?? []), s]);
  const out: { session: Session; depth: number; kids: number; up: string[] }[] = [];
  const walk = (s: Session, depth: number, up: string[]) => {
    if (seen.has(s.id)) return; seen.add(s.id);
    const mine = (kids.get(s.id) ?? []).filter(k => !seen.has(k.id));
    out.push({ session: s, depth, kids: mine.length, up });
    for (const k of mine) walk(k, Math.min(depth + 1, 3), [...up, s.id]);
  };
  for (const s of items) if (!s.parent_id || !ids.has(s.parent_id)) walk(s, 0, []);
  for (const s of items) walk(s, 0, []); // cycle safety: nothing is ever dropped
  return out;
}
// Pinned chats lead each list (most recently pinned first); the rest keep their order.
const pinFirst = (items: Session[]) => [...items].sort((a, b) => (b.pinned || 0) - (a.pinned || 0));
export function Sessions({ api }: { api: PluginAPI }) {
  const { state } = useHost(), { busy, run } = useOperation(api, !!state.parallel_runs);
  const [toggled, setToggled] = useState(loadToggles), [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState(''), [moving, setMoving] = useState('');
  const [layout, setLayout] = useState(loadLayout), [menu, setMenu] = useState<string>('');
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(''); };
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(''); };
    document.addEventListener('pointerdown', close, true); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', esc); };
  }, [menu]);
  // Layout and group toggles are persisted on the host (shared by every client, incl. remote);
  // localStorage is only a first-paint cache. A local edit made before the fetch lands wins.
  const edited = useRef(false);
  const persist = (key: 'sidebar.layout' | 'sidebar.groups', value: unknown) => {
    edited.current = true; void api.post('', { key, value }).catch(() => undefined);
  };
  useEffect(() => {
    void api.get<{ prefs?: Record<string, unknown> }>('').then(res => {
      if (edited.current) return;
      const prefs = res?.prefs ?? {};
      if (prefs['sidebar.layout'] !== undefined) { const next = normalizeLayout(prefs['sidebar.layout']); setLayout(next); save(LAYOUT_KEY, JSON.stringify(next)); }
      else if (saved(LAYOUT_KEY)) void api.post('', { key: 'sidebar.layout', value: loadLayout() }).catch(() => undefined);
      const groups = prefs['sidebar.groups'];
      if (groups && typeof groups === 'object' && !Array.isArray(groups)) { setToggled(groups as Record<string, boolean>); save('gah.sessions.groups', JSON.stringify(groups)); }
      else if (saved('gah.sessions.groups')) void api.post('', { key: 'sidebar.groups', value: loadToggles() }).catch(() => undefined);
    }).catch(() => undefined);
  }, []);
  const updateLayout = (edit: (old: Layout) => Layout) => setLayout(old => { const next = normalizeLayout(edit(old)); if (JSON.stringify(next) !== JSON.stringify(old)) { save(LAYOUT_KEY, JSON.stringify(next)); persist('sidebar.layout', next); } return next; });
  const setSection = (key: SectionKey, patch: Partial<SectionPref>) => updateLayout(old => ({ ...old, sections: { ...old.sections, [key]: { ...old.sections[key], ...patch } } }));
  const moveSection = (key: SectionKey, delta: number) => updateLayout(old => {
    const order = [...old.order], from = order.indexOf(key), to = from + delta;
    if (to < 0 || to >= order.length) return old;
    [order[from], order[to]] = [order[to], order[from]]; return { ...old, order };
  });
  const scope = state.scope, projects = scope?.projects ?? [];
  const current = scope?.project_id ? `p:${scope.project_id}` : 'recent', previous = useRef(current);
  useEffect(() => {
    if (previous.current !== current) { previous.current = current; setToggled(old => { const next = { ...old }; delete next[current]; return next; }); }
  }, [current]);
  const change = (path: string, body: object, reset: boolean) => run(async () => {
    const next = await api.host.post<HostState>(path, body); api.setState(next, reset);
    // Opening or creating a chat leaves any plugin page route.
    if (reset) pages.home();
  });
  const act = (action: string, extra: object = {}) => change('/api/sessions', { action, id: state.session_id, ...extra }, ['new', 'select', 'delete', 'clear'].includes(action));
  const scoped = (body: object, reset = true) => change('/api/p/web-workspaces/', body, reset);
  const dialog = (action: string, id?: string) => window.dispatchEvent(new CustomEvent('gah:workspace-dialog', { detail: { action, id } }));
  const toggle = (key: string, open: boolean) => setToggled(old => { const next = { ...old, [key]: !open }; save('gah.sessions.groups', JSON.stringify(next)); persist('sidebar.groups', next); return next; });
  const activity = new Map<string, string>();
  for (const item of state.runs ?? []) if (item.status === 'running' || item.status === 'cancelling') activity.set(item.session_id, item.status);
  if (state.running && state.session_id && !activity.has(state.session_id)) activity.set(state.session_id, 'running');
  const q = query.trim().toLowerCase();
  const known = new Set(projects.map(p => p.id)), byProject = new Map<string, Session[]>(), recentAll: Session[] = [];
  const projectName = new Map(projects.map(p => [p.id, p.name]));
  for (const s of state.sessions ?? []) {
    if (q && !label(s).toLowerCase().includes(q) && !(s.workspace ?? '').toLowerCase().includes(q)) continue;
    recentAll.push(s);
    if (s.project_id && known.has(s.project_id)) byProject.set(s.project_id, [...(byProject.get(s.project_id) ?? []), s]);
  }
  // Sub-chats start collapsed under their parent; the open chat's ancestors stay expanded and search shows all.
  const byId = new Map((state.sessions ?? []).map(s => [s.id, s] as const)), lineage = new Set<string>();
  for (let s = byId.get(state.session_id ?? ''); s?.parent_id && !lineage.has(s.parent_id); s = byId.get(s.parent_id)) lineage.add(s.parent_id);
  const kidsOpen = (id: string) => !!q || (toggled[`c:${id}`] ?? lineage.has(id));
  const row = (session: Session, depth: number, home?: string, recent = false, kids = 0) => {
    const kidsShown = kids > 0 && kidsOpen(session.id);
    const menuKey = `s:${session.id}`, menuOpen = menu === menuKey;
    const pick = (fn: () => void) => () => { setMenu(''); fn(); };
    // In Recent, a project chat is tagged with its project name instead of the workspace.
    const owner = recent && session.project_id ? projectName.get(session.project_id) : undefined;
    const status = activity.get(session.id), tag = owner ?? (session.workspace && session.workspace !== home ? base(session.workspace) : '');
    const unread = !status && !!session.unread && !session.parent_id && session.id !== state.session_id;
    return <div key={session.id} className={`gah-sess-row${session.id === state.session_id ? ' current' : ''}${status ? ' running' : ''}${unread ? ' unread' : ''}${depth ? ' child' : ''}${kids ? ' parent' : ''}${menuOpen ? ' menu-open' : ''}`} style={depth ? { '--gah-depth': depth } as CSSProperties : undefined} role="listitem">
      <button type="button" className="gah-sess-open" disabled={busy} data-gah-close="" onClick={() => void act('select', { id: session.id })} title={[label(session), session.workspace, stamp(session.updated)].filter(Boolean).join('\n')}>
        {session.pinned ? <span className="gah-sess-pin" aria-label={T('\u5df2\u7f6e\u9876', 'Pinned')}><Icon name="pin" /></span> : null}<span className="gah-sess-title">{depth ? label(session).replace(/^\u25b8\s*/, '') : label(session)}</span>{tag && <span className="gah-sess-tag">{tag}</span>}
        {unread && <span className="gah-sess-unread" role="status" title={T('\u672a\u8bfb', 'Unread')} aria-label={T('\u672a\u8bfb', 'Unread')} />}
        {!status && session.updated ? <span className="gah-sess-age">{ago(session.updated)}</span> : null}
        {status && <span className={`gah-sess-status ${status}`} role="status" title={status === 'cancelling' ? T('\u6b63\u5728\u505c\u6b62', 'Stopping') : T('\u8fd0\u884c\u4e2d', 'Running')} aria-label={status === 'cancelling' ? T('\u6b63\u5728\u505c\u6b62', 'Stopping') : T('\u8fd0\u884c\u4e2d', 'Running')} />}</button>
      {kids > 0 && <button type="button" className={`gah-sess-kids${kidsShown ? ' open' : ''}`} aria-expanded={kidsShown} disabled={!!q}
        title={kidsShown ? T('\u6536\u8d77\u5b50\u4f1a\u8bdd', 'Collapse sub-chats') : T('\u5c55\u5f00\u5b50\u4f1a\u8bdd', 'Expand sub-chats')}
        aria-label={kidsShown ? T('\u6536\u8d77\u5b50\u4f1a\u8bdd', 'Collapse sub-chats') : T('\u5c55\u5f00\u5b50\u4f1a\u8bdd', 'Expand sub-chats')}
        onClick={() => toggle(`c:${session.id}`, kidsShown)}><span className="gah-sess-kids-n">{kids}</span><span className="gah-sess-caret" aria-hidden="true" /></button>}
      <span className="gah-sess-acts" ref={menuOpen ? menuRef : undefined}>
        <button type="button" className={`gah-sess-act gah-sess-more-btn${menuOpen ? ' on' : ''}`} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={T('\u66f4\u591a\u64cd\u4f5c', 'More actions')} title={T('\u66f4\u591a\u64cd\u4f5c', 'More actions')} onClick={() => setMenu(m => m === menuKey ? '' : menuKey)}><span className="gah-sess-dots" aria-hidden="true">{'\u22ef'}</span></button>
        {menuOpen && <div className="gah-sess-menu gah-sess-row-menu" role="menu" aria-label={T('\u66f4\u591a\u64cd\u4f5c', 'More actions')}>
          <button type="button" role="menuitem" className="gah-sess-menu-item" disabled={busy} onClick={pick(() => void act(session.pinned ? 'unpin' : 'pin', { id: session.id }))}><Icon name="pin" />{session.pinned ? T('\u53d6\u6d88\u7f6e\u9876', 'Unpin') : T('\u7f6e\u9876', 'Pin')}</button>
          <button type="button" role="menuitem" className="gah-sess-menu-item" disabled={busy} onClick={pick(async () => { const title = await promptDialog({ title: T('\u91cd\u547d\u540d\u4f1a\u8bdd', 'Rename chat'), placeholder: T('\u4f1a\u8bdd\u540d\u79f0', 'Chat name'), value: session.title, confirm: T('\u4fdd\u5b58', 'Save') }); if (title?.trim()) void act('rename', { id: session.id, title: title.trim() }); })}><Icon name="pencil" />{T('\u91cd\u547d\u540d', 'Rename')}</button>
          <button type="button" role="menuitem" className="gah-sess-menu-item" disabled={busy || !!status} onClick={pick(() => setMoving(session.id))}><Icon name="folder" />{T('\u79fb\u52a8\u5230\u9879\u76ee', 'Move to project')}</button>
          <div className="gah-sess-menu-sep" />
          <button type="button" role="menuitem" className="gah-sess-menu-item danger" disabled={busy} onClick={pick(async () => { if (await confirmDialog({ title: T('\u5220\u9664\u4f1a\u8bdd', 'Remove chat'), danger: true, confirm: T('\u5220\u9664', 'Remove'), message: T('\u4ece\u5217\u8868\u5220\u9664\u6b64\u4f1a\u8bdd\uff1f\u5386\u53f2\u8bb0\u5f55\u4fdd\u7559\u5728\u672c\u5730\u6570\u636e\u5e93\u3002', 'Remove this chat from the list? History stays in the local database.') })) void act('delete', { id: session.id }); })}><Icon name="trash" />{T('\u5220\u9664', 'Remove')}</button>
        </div>}</span>
      {moving === session.id && <select className="gah-sess-move" autoFocus aria-label={T('\u79fb\u52a8\u5230\u9879\u76ee', 'Move to project')} value={session.project_id && known.has(session.project_id) ? session.project_id : ''}
        onKeyDown={event => { if (event.key === 'Escape') setMoving(''); }} onBlur={() => setMoving('')}
        onChange={event => { const target = event.target.value; setMoving(''); void scoped({ action: 'move', session_id: session.id, project_id: target }, false); }}>
        <option value="">{T('\u65e0\u9879\u76ee', 'No project')}</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
    </div>;
  };
  // Long groups show the latest few (plus the open chat); searching always shows every match.
  const list = (key: string, items: Session[], home: string | undefined, limit: number, recent = false) => {
    const rows = nest(pinFirst(items)).filter(r => r.up.every(kidsOpen)), all = !!q || !!expanded[key];
    const shown = all ? rows : rows.filter((r, i) => i < limit || r.session.id === state.session_id || !!r.session.pinned);
    return <div className="gah-sess-items" role="list">
      {rows.length ? shown.map(r => row(r.session, r.depth, home, recent, r.kids)) : <div className="gah-sess-empty">{q ? T('\u65e0\u5339\u914d\u4f1a\u8bdd', 'No matching chats') : T('\u6682\u65e0\u4f1a\u8bdd', 'No chats yet')}</div>}
      {!q && rows.length > limit && <button type="button" className="gah-sess-more" onClick={() => setExpanded(old => ({ ...old, [key]: !all }))}>{all ? T('\u6536\u8d77', 'Show less') : `${T('\u663e\u793a\u5168\u90e8', 'Show all')} (${rows.length})`}</button>}
    </div>;
  };
  // Projects matching the search; the Projects count caps how many groups render (the open project always stays).
  const projectCap = layout.sections.projects.count, allProjects = !!q || !!expanded['projects:all'];
  const matchedProjects = projects.filter(p => !q || (byProject.get(p.id) ?? []).length || p.name.toLowerCase().includes(q));
  const cappedProjects = allProjects ? matchedProjects : matchedProjects.filter((p, i) => i < projectCap || `p:${p.id}` === current);
  const projectGroups = cappedProjects.map(p => {
    const key = `p:${p.id}`, items = byProject.get(p.id) ?? [];
    const isCurrent = key === current, open = q ? true : toggled[key] ?? isCurrent;
    return <section key={key} className={`gah-group project${isCurrent ? ' current' : ''}`} data-key={key}>
      <div className="gah-group-head"><button type="button" className="gah-group-toggle" title={p.workspace} aria-expanded={open} onClick={() => toggle(key, open)}><span className="gah-ico gah-ico-closed" data-i="folder" aria-hidden="true" /><span className="gah-ico gah-ico-open" data-i="folder-open" aria-hidden="true" /><span className="gah-group-name">{p.name}</span><span className="gah-group-count">{(byProject.get(p.id) ?? []).length}</span></button>
        <button type="button" className="gah-group-add" disabled={busy} data-gah-close="" aria-label={`${T('\u65b0\u5efa\u5bf9\u8bdd', 'New chat')}: ${p.name}`} onClick={() => void (isCurrent ? act('new') : scoped({ action: 'enter', id: p.id }))}><Icon name="plus" /></button>
        <button type="button" className="gah-group-add" disabled={busy} aria-label={`${T('\u9879\u76ee\u8bbe\u7f6e', 'Project settings')}: ${p.name}`} onClick={() => dialog('update', p.id)}><Icon name="pencil" /></button>
        <button type="button" className="gah-group-add" disabled={busy} aria-label={`${T('\u5220\u9664\u9879\u76ee', 'Delete project')}: ${p.name}`} onClick={async () => { if (await confirmDialog({ title: T('\u5220\u9664\u9879\u76ee', 'Delete project'), danger: true, confirm: T('\u5220\u9664', 'Delete'), message: T('\u5220\u9664\u9879\u76ee\u201c', 'Delete project "') + p.name + T('\u201d\uff1f\u5176\u4e2d\u7684\u4f1a\u8bdd\u4f1a\u79fb\u5230\u201c\u6700\u8fd1\u201d\uff0c\u9879\u76ee\u8bb0\u5fc6\u6587\u4ef6\u4fdd\u7559\u5728\u78c1\u76d8\u4e0a\u3002', '"? Its chats move to Recent; the project memory files stay on disk.') })) void scoped({ action: 'delete', id: p.id }, isCurrent); }}><Icon name="trash" /></button></div>
      {open && list(key, items, p.workspace || scope?.default_workspace, projectCap)}
    </section>;
  });
  const sectionMenu = (key: SectionKey, open: boolean) => {
    const pref = layout.sections[key], name = sectionName(key), index = layout.order.indexOf(key);
    const pick = (fn: () => void) => () => { fn(); setMenu(''); };
    const hidden = layout.order.filter(k => k !== key && !layout.sections[k].show);
    return <div className="gah-sess-menu" role="menu" aria-label={`${name}: ${T('\u7f16\u8f91\u5206\u533a', 'Edit section')}`}>
      <div className="gah-sess-menu-title">{T('\u663e\u793a\u4e2a\u6570', 'Display count')}</div>
      <div className="gah-sess-menu-counts">{SECTION_COUNTS.map(n => <button key={n} type="button" role="menuitemradio" aria-checked={pref.count === n} className={`gah-sess-menu-count${pref.count === n ? ' on' : ''}`} onClick={pick(() => setSection(key, { count: n }))}>{n}</button>)}</div>
      <div className="gah-sess-menu-sep" />
      <button type="button" role="menuitem" className="gah-sess-menu-item" disabled={!!q} onClick={pick(() => setSection(key, { open: !open }))}>{open ? T('\u6536\u8d77\u5206\u533a', 'Collapse section') : T('\u5c55\u5f00\u5206\u533a', 'Expand section')}</button>
      <button type="button" role="menuitem" className="gah-sess-menu-item" disabled={index <= 0} onClick={pick(() => moveSection(key, -1))}>{T('\u4e0a\u79fb', 'Move up')}</button>
      <button type="button" role="menuitem" className="gah-sess-menu-item" disabled={index >= layout.order.length - 1} onClick={pick(() => moveSection(key, 1))}>{T('\u4e0b\u79fb', 'Move down')}</button>
      <button type="button" role="menuitem" className="gah-sess-menu-item" onClick={pick(() => setSection(key, { show: false }))}>{T('\u9690\u85cf\u6b64\u5206\u533a', 'Hide this section')}</button>
      {hidden.map(k => <button key={k} type="button" role="menuitem" className="gah-sess-menu-item" onClick={pick(() => setSection(k, { show: true }))}>{T('\u663e\u793a\u201c', 'Show "') + sectionName(k) + T('\u201d', '"')}</button>)}
      <div className="gah-sess-menu-sep" />
      <button type="button" role="menuitem" className="gah-sess-menu-item" disabled={busy || !(state.sessions ?? []).some(s => s.unread)} onClick={pick(() => void act('read_all'))}>{T('\u5168\u90e8\u6807\u4e3a\u5df2\u8bfb', 'Mark all as read')}</button>
      <button type="button" role="menuitem" className="gah-sess-menu-item" onClick={pick(() => updateLayout(() => normalizeLayout()))}>{T('\u6062\u590d\u9ed8\u8ba4', 'Restore defaults')}</button>
    </div>;
  };
  const sectionHead = (key: SectionKey, open: boolean, action: ReactNode) => <div className="gah-sess-label" ref={menu === key ? menuRef : undefined}>
    <button type="button" className="gah-sess-label-toggle" aria-expanded={open} disabled={!!q} title={open ? T('\u6536\u8d77\u5206\u533a', 'Collapse section') : T('\u5c55\u5f00\u5206\u533a', 'Expand section')} onClick={() => setSection(key, { open: !open })}>
      <span className="gah-sess-chevron" aria-hidden="true" /><span>{sectionName(key)}</span></button>
    <button type="button" className={`gah-sess-head-btn gah-sess-edit${menu === key ? ' on' : ''}`} aria-haspopup="menu" aria-expanded={menu === key} aria-label={`${sectionName(key)}: ${T('\u7f16\u8f91\u5206\u533a', 'Edit section')}`} title={T('\u7f16\u8f91\u5206\u533a', 'Edit section')} onClick={() => setMenu(m => m === key ? '' : key)}><Icon name="pencil" /></button>
    {action}{menu === key && sectionMenu(key, open)}</div>;
  const sections: Record<SectionKey, () => ReactNode> = {
    projects: () => {
      const open = !!q || layout.sections.projects.open;
      return <div key="projects" className="gah-sess-section" data-section="projects">
        {sectionHead('projects', open, <button type="button" className="gah-sess-head-btn" disabled={busy} aria-label={T('\u65b0\u5efa\u9879\u76ee', 'New project')} onClick={() => dialog('create')}><Icon name="folder-plus" /></button>)}
        {open && (projects.length ? <>{projectGroups}
          {!q && matchedProjects.length > projectCap && <button type="button" className="gah-sess-more" onClick={() => setExpanded(old => ({ ...old, 'projects:all': !allProjects }))}>{allProjects ? T('\u6536\u8d77\u9879\u76ee', 'Show fewer projects') : `${T('\u663e\u793a\u5168\u90e8\u9879\u76ee', 'Show all projects')} (${matchedProjects.length})`}</button>}</>
          : <div className="gah-sess-empty">{T('\u8fd8\u6ca1\u6709\u9879\u76ee', 'No projects yet')}</div>)}
      </div>;
    },
    recent: () => {
      const open = !!q || layout.sections.recent.open;
      return <div key="recent" className="gah-sess-section" data-section="recent">
        {sectionHead('recent', open, <button type="button" className="gah-sess-head-btn" disabled={busy} data-gah-close="" aria-label={T('\u65b0\u5efa\u5bf9\u8bdd', 'New chat')} onClick={() => void (current === 'recent' ? act('new') : scoped({ action: 'enter' }))}><Icon name="plus" /></button>)}
        {open && <section className={`gah-group recent${current === 'recent' ? ' current' : ''}`} data-key="recent">{list('recent', recentAll, scope?.project_id ? undefined : scope?.workspace, layout.sections.recent.count, true)}</section>}
      </div>;
    },
  };
  const shownSections = layout.order.filter(key => layout.sections[key].show);
  return <PluginSlot api={api} name="sidebar"><div className="gah-sessions" hidden={!state.sessions}>
    <button type="button" className="side-item gah-sess-new" disabled={busy} title={scope?.project ? `${T('\u5728\u9879\u76ee\u4e2d\u65b0\u5efa', 'New chat in')}: ${scope.project.name}` : T('\u65b0\u5efa\u672a\u7ed1\u5b9a\u9879\u76ee\u7684\u5bf9\u8bdd', 'New chat without a project')} data-gah-close="" onClick={() => void act('new')}><Icon name="pen" />{T('\u65b0\u4f1a\u8bdd', 'New chat')}</button><PageNav />
    <input type="search" className="gah-sess-search" value={query} placeholder={T('\u641c\u7d22\u4f1a\u8bdd', 'Search chats')} aria-label={T('\u641c\u7d22\u4f1a\u8bdd', 'Search chats')} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setQuery(''); }} />
    <div className="gah-sess-list" aria-label={T('\u4f1a\u8bdd\u5217\u8868', 'Chats')}>
      {scope ? <>
        {shownSections.map(key => sections[key]())}
        {!shownSections.length && <div className="gah-sess-empty">{T('\u6240\u6709\u5206\u533a\u5df2\u9690\u85cf', 'All sections are hidden')} <button type="button" className="gah-sess-more" onClick={() => updateLayout(old => ({ ...old, sections: Object.fromEntries(SECTION_KEYS.map(k => [k, { ...old.sections[k], show: true }])) as Layout['sections'] }))}>{T('\u5168\u90e8\u663e\u793a', 'Show all')}</button></div>}
      </> : <div className="gah-sess-items flat" role="list">{pinFirst((state.sessions ?? []).filter(s => !q || label(s).toLowerCase().includes(q))).map(s => row(s, 0))}</div>}
    </div></div></PluginSlot>;
}

defineReact('web-sessions', Sessions);
