import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { type PluginAPI, type HostState, type Session, useHost, useDraftSessions, saved, save, T, Icon, confirmDialog, promptDialog, PluginSlot, PageNav, pages, useOperation, defineReact } from '@gah/sdk';

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
export const PROJECT_SORTS = ['custom', 'recent', 'name', 'count'] as const;
type ProjectSort = typeof PROJECT_SORTS[number];
type Layout = { order: SectionKey[]; sections: Record<SectionKey, SectionPref>; projectSort: ProjectSort; projectOrder: string[] };
const sortName = (k: ProjectSort) => k === 'custom' ? T('\u81ea\u5b9a\u4e49', 'Custom') : k === 'recent' ? T('\u6700\u65b0\u4f1a\u8bdd\u65f6\u95f4', 'Latest chat') : k === 'name' ? T('\u540d\u79f0', 'Name') : T('\u4f1a\u8bdd\u6570\u91cf', 'Chat count');
const LAYOUT_KEY = 'gah.sessions.layout', DEFAULT_COUNT: Record<SectionKey, number> = { projects: 5, recent: 10 };
const sectionName = (key: SectionKey) => key === 'projects' ? T('\u9879\u76ee', 'Projects') : T('\u6700\u8fd1', 'Recent');
export function normalizeLayout(value?: unknown): Layout {
  const raw = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as { order?: unknown; projectSort?: unknown; projectOrder?: unknown; sections?: Record<string, Partial<SectionPref> | undefined> };
  const valid = Array.isArray(raw.order) ? [...new Set(raw.order.filter((k): k is SectionKey => SECTION_KEYS.includes(k as SectionKey)))] : [];
  const order = [...valid, ...SECTION_KEYS.filter(k => !valid.includes(k))];
  const sections = Object.fromEntries(SECTION_KEYS.map(k => {
    const old = raw.sections && typeof raw.sections === 'object' ? raw.sections[k] ?? {} : {};
    return [k, { show: typeof old.show === 'boolean' ? old.show : true, open: typeof old.open === 'boolean' ? old.open : true,
      count: SECTION_COUNTS.includes(Number(old.count)) ? Number(old.count) : DEFAULT_COUNT[k] }];
  })) as Record<SectionKey, SectionPref>;
  const projectSort = PROJECT_SORTS.includes(raw.projectSort as ProjectSort) ? raw.projectSort as ProjectSort : 'custom';
  const projectOrder = Array.isArray(raw.projectOrder) ? [...new Set(raw.projectOrder.filter((x): x is string => typeof x === 'string'))] : [];
  return { order, sections, projectSort, projectOrder };
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
  const drafts = useDraftSessions();
  const [toggled, setToggled] = useState(loadToggles), [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState(''), [moving, setMoving] = useState('');
  const [layout, setLayout] = useState(loadLayout), [menu, setMenu] = useState<string>('');
  // Project reorder mode: the move arrows only appear after it is switched on from the Projects menu.
  const [reordering, setReordering] = useState(false);
  // Pointer drag in reorder mode (mouse, pen and touch): the dragged project id and the drop slot under the pointer.
  const [drag, setDrag] = useState<{ id: string; target: string; after: boolean } | null>(null);
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
  const scope = state.scope, rawProjects = scope?.projects ?? [];
  // Ignore pinned-first server order when deriving the default manual order.
  const defaultOrder = [...rawProjects].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0) || a.id.localeCompare(b.id)).map(p => p.id);
  // Project order: custom = the user's saved order (new projects keep their store order after it);
  // otherwise derived from the chats (latest activity / count) or the name. Ties fall back to the custom order.
  const customRank = new Map<string, number>(), seenIds = new Set(rawProjects.map(p => p.id));
  [...layout.projectOrder.filter(id => seenIds.has(id)), ...defaultOrder.filter(id => !layout.projectOrder.includes(id))].forEach((id, i) => customRank.set(id, i));
  const latest = new Map<string, number>(), counts = new Map<string, number>();
  for (const s of state.sessions ?? []) if (s.project_id) {
    latest.set(s.project_id, Math.max(latest.get(s.project_id) ?? 0, s.updated ?? 0)); counts.set(s.project_id, (counts.get(s.project_id) ?? 0) + 1);
  }
  const projects = [...rawProjects].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const by = layout.projectSort === 'recent' ? (latest.get(b.id) ?? 0) - (latest.get(a.id) ?? 0)
      : layout.projectSort === 'count' ? (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0)
      : layout.projectSort === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : 0;
    return by || (customRank.get(a.id) ?? 0) - (customRank.get(b.id) ?? 0);
  });
  const moveProject = (id: string, delta: number) => updateLayout(old => {
    const ids = projects.map(p => p.id), from = ids.indexOf(id), to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length || !!projects[from].pinned !== !!projects[to].pinned) return old;
    [ids[from], ids[to]] = [ids[to], ids[from]]; return { ...old, projectOrder: ids };
  });
  const dropProject = (id: string, target: string, after: boolean) => updateLayout(old => {
    if (id === target || !!projects.find(p => p.id === id)?.pinned !== !!projects.find(p => p.id === target)?.pinned) return old;
    const ids = projects.map(p => p.id).filter(x => x !== id), at = ids.indexOf(target);
    if (at < 0) return old;
    ids.splice(at + (after ? 1 : 0), 0, id); return { ...old, projectOrder: ids };
  });
  const dragSlot = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.gah-group.project'), key = el?.dataset.key;
    if (!el || !key?.startsWith('p:')) return null;
    if (drag && !!projects.find(p => p.id === drag.id)?.pinned !== !!projects.find(p => p.id === key.slice(2))?.pinned) return null;
    const box = el.getBoundingClientRect(); return { target: key.slice(2), after: y > box.top + box.height / 2 };
  };
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
  // A project shows the strongest state of any of its chats (running beats stopping), even while collapsed or filtered out.
  const projectStatus = new Map<string, string>();
  for (const s of state.sessions ?? []) {
    const st = s.project_id ? activity.get(s.id) : undefined;
    if (s.project_id && st && projectStatus.get(s.project_id) !== 'running') projectStatus.set(s.project_id, st);
  }
  const q = query.trim().toLowerCase();
  // Conductor task chats are opened from the Conductor panel, so the sidebar hides them unless searching
  // or they lead to the open chat (which keeps the way back to the conductor visible).
  const conductorState = (state as unknown as { conductor?: { children?: Record<string, unknown>; enabled?: string[] } }).conductor;
  const conductorKids = conductorState?.children ?? {};
  // Chats in Conductor mode get a small baton mark so they stand out in the list.
  const conductorOn = new Set<string>(conductorState?.enabled ?? []);
  const openPath = new Set<string>(state.session_id ? [state.session_id] : []);
  { const all = new Map((state.sessions ?? []).map(s => [s.id, s] as const));
    for (let s = all.get(state.session_id ?? ''); s?.parent_id && !openPath.has(s.parent_id); s = all.get(s.parent_id)) openPath.add(s.parent_id); }
  const tucked = (s: Session) => !q && Object.prototype.hasOwnProperty.call(conductorKids, s.id) && !openPath.has(s.id);
  const known = new Set(projects.map(p => p.id)), byProject = new Map<string, Session[]>(), recentAll: Session[] = [];
  const projectName = new Map(projects.map(p => [p.id, p.name]));
  for (const s of state.sessions ?? []) {
    if (tucked(s) || (q && !label(s).toLowerCase().includes(q) && !(s.workspace ?? '').toLowerCase().includes(q))) continue;
    recentAll.push(s);
    if (s.project_id && known.has(s.project_id)) byProject.set(s.project_id, [...(byProject.get(s.project_id) ?? []), s]);
  }
  // Sub-chats start collapsed under their parent; the open chat's ancestors stay expanded and search shows all.
  const byId = new Map((state.sessions ?? []).map(s => [s.id, s] as const)), lineage = new Set<string>();
  for (let s = byId.get(state.session_id ?? ''); s?.parent_id && !lineage.has(s.parent_id); s = byId.get(s.parent_id)) lineage.add(s.parent_id);
  const kidsOpen = (id: string) => !!q || (toggled[`c:${id}`] ?? lineage.has(id));
  // Ancestors of a running sub-chat (e.g. a Conductor waiting on its tasks) get a separate, lighter indicator with the count.
  const subActivity = new Map<string, { n: number; status: string }>();
  for (const [id, st] of activity) {
    const seen = new Set([id]);
    for (let s = byId.get(id); s?.parent_id && !seen.has(s.parent_id); s = byId.get(s.parent_id)) {
      seen.add(s.parent_id);
      const cur = subActivity.get(s.parent_id) ?? { n: 0, status: st };
      cur.n += 1; if (st === 'running') cur.status = 'running';
      subActivity.set(s.parent_id, cur);
    }
  }
  // Debug bundle for one chat (messages, agent state, run events, matching log lines) from
  // GET /api/session-export, saved as JSON. Read-only, so it stays available while a run is active.
  const exportChat = async (id: string) => {
    try {
      const data = await api.host.get<unknown>('/api/session-export?session_id=' + encodeURIComponent(id));
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = `gah-session-${id.slice(0, 12)}-${ts}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      api.notice(T('\u5bfc\u51fa\u5931\u8d25\uff1a', 'Export failed: ') + ((e as Error)?.message || String(e)));
    }
  };
  const row = (session: Session, depth: number, home?: string, recent = false, kids = 0) => {
    const kidsShown = kids > 0 && kidsOpen(session.id);
    const menuKey = `s:${session.id}:${recent ? 'r' : 'p'}:${home ?? ''}`, menuOpen = menu === menuKey;
    const pick = (fn: () => void) => () => { setMenu(''); fn(); };
    // Rows are tagged with the project name only (Recent; inside a project group it is implied); the workspace lives in the tooltip.
    const project = session.project_id ? projectName.get(session.project_id) : undefined;
    const status = activity.get(session.id), sub = status ? undefined : subActivity.get(session.id), tag = recent ? project ?? '' : '';
    const subLabel = sub && (sub.status === 'cancelling' ? T(`\u5b50\u4efb\u52a1\u6b63\u5728\u505c\u6b62 (${sub.n})`, `Sub-chats stopping (${sub.n})`) : T(`\u5b50\u4efb\u52a1\u8fd0\u884c\u4e2d (${sub.n})`, `Sub-chats running (${sub.n})`));
    const unread = !status && !!session.unread && !session.parent_id && session.id !== state.session_id;
    // The open chat shows its draft in the composer; other rows flag unsent text or attachments.
    const draft = session.id !== state.session_id && drafts.has(session.id);
    return <div key={session.id} className={`gah-sess-row${session.id === state.session_id ? ' current' : ''}${status ? ' running' : ''}${sub ? ' sub-running' : ''}${unread ? ' unread' : ''}${depth ? ' child' : ''}${kids ? ' parent' : ''}${menuOpen ? ' menu-open' : ''}`} style={depth ? { '--gah-depth': depth } as CSSProperties : undefined} role="listitem">
      <button type="button" className="gah-sess-open" disabled={busy} data-gah-close="" onClick={() => void act('select', { id: session.id })} title={[label(session), project && `${T('\u9879\u76ee', 'Project')}: ${project}`, session.workspace && `${T('\u5de5\u4f5c\u533a', 'Workspace')}: ${session.workspace}`, stamp(session.updated)].filter(Boolean).join('\n')}>
        {session.pinned ? <span className="gah-sess-pin" aria-label={T('\u5df2\u7f6e\u9876', 'Pinned')}><Icon name="pin" /></span> : null}{conductorOn.has(session.id) ? <span className="gah-sess-conductor" title={T('\u6307\u6325\u5bb6\u4f1a\u8bdd', 'Conductor chat')} aria-label={T('\u6307\u6325\u5bb6\u4f1a\u8bdd', 'Conductor chat')}><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 3.5h4M3 8h10M3 12.5h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" /><circle cx="11" cy="3.5" r="1.6" fill="currentColor" /><circle cx="12" cy="12.5" r="1.6" fill="currentColor" /></svg></span> : null}<span className="gah-sess-title">{depth ? label(session).replace(/^\u25b8\s*/, '') : label(session)}</span>{tag && <span className="gah-sess-tag">{tag}</span>}
        {draft && <span className="gah-sess-draft" title={T('\u6709\u672a\u53d1\u9001\u7684\u8349\u7a3f', 'Unsent draft')}>{T('\u8349\u7a3f', 'Draft')}</span>}
        {unread && <span className="gah-sess-unread" role="status" title={T('\u672a\u8bfb', 'Unread')} aria-label={T('\u672a\u8bfb', 'Unread')} />}
        {!status && !sub && session.updated ? <span className="gah-sess-age">{ago(session.updated)}</span> : null}
        {status && <span className={`gah-sess-status ${status}`} role="status" title={status === 'cancelling' ? T('\u6b63\u5728\u505c\u6b62', 'Stopping') : T('\u8fd0\u884c\u4e2d', 'Running')} aria-label={status === 'cancelling' ? T('\u6b63\u5728\u505c\u6b62', 'Stopping') : T('\u8fd0\u884c\u4e2d', 'Running')} />}
        {sub && <span className={`gah-sess-status sub ${sub.status}`} role="status" title={subLabel} aria-label={subLabel} />}</button>
      {kids > 0 && <button type="button" className={`gah-sess-kids${kidsShown ? ' open' : ''}${sub ? ` busy ${sub.status}` : ''}`} aria-expanded={kidsShown} disabled={!!q}
        title={kidsShown ? T('\u6536\u8d77\u5b50\u4f1a\u8bdd', 'Collapse sub-chats') : T('\u5c55\u5f00\u5b50\u4f1a\u8bdd', 'Expand sub-chats')}
        aria-label={kidsShown ? T('\u6536\u8d77\u5b50\u4f1a\u8bdd', 'Collapse sub-chats') : T('\u5c55\u5f00\u5b50\u4f1a\u8bdd', 'Expand sub-chats')}
        onClick={() => toggle(`c:${session.id}`, kidsShown)}><span className="gah-sess-kids-n">{kids}</span><span className="gah-sess-caret" aria-hidden="true" /></button>}
      <span className="gah-sess-acts" ref={menuOpen ? menuRef : undefined}>
        <button type="button" className={`gah-sess-act gah-sess-more-btn${menuOpen ? ' on' : ''}`} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={T('\u66f4\u591a\u64cd\u4f5c', 'More actions')} title={T('\u66f4\u591a\u64cd\u4f5c', 'More actions')} onClick={() => setMenu(m => m === menuKey ? '' : menuKey)}><span className="gah-sess-dots" aria-hidden="true">{'\u22ef'}</span></button>
        {menuOpen && <div className="gah-sess-menu gah-sess-row-menu" role="menu" aria-label={T('\u66f4\u591a\u64cd\u4f5c', 'More actions')}>
          <button type="button" role="menuitem" className="gah-sess-menu-item" disabled={busy} onClick={pick(() => void act(session.pinned ? 'unpin' : 'pin', { id: session.id }))}><Icon name="pin" />{session.pinned ? T('\u53d6\u6d88\u7f6e\u9876', 'Unpin') : T('\u7f6e\u9876', 'Pin')}</button>
          <button type="button" role="menuitem" className="gah-sess-menu-item" disabled={busy} onClick={pick(async () => { const title = await promptDialog({ title: T('\u91cd\u547d\u540d\u4f1a\u8bdd', 'Rename chat'), placeholder: T('\u4f1a\u8bdd\u540d\u79f0', 'Chat name'), value: session.title, confirm: T('\u4fdd\u5b58', 'Save') }); if (title?.trim()) void act('rename', { id: session.id, title: title.trim() }); })}><Icon name="pencil" />{T('\u91cd\u547d\u540d', 'Rename')}</button>
          <button type="button" role="menuitem" className="gah-sess-menu-item" disabled={busy || !!status} onClick={pick(() => setMoving(session.id))}><Icon name="folder" />{T('\u79fb\u52a8\u5230\u9879\u76ee', 'Move to project')}</button>
          <button type="button" role="menuitem" className="gah-sess-menu-item" onClick={pick(() => void exportChat(session.id))}><Icon name="download" />{T('\u5bfc\u51fa\u8c03\u8bd5\u65e5\u5fd7', 'Export debug log')}</button>
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
  const sorting = reordering && layout.projectSort === 'custom' && !q;
  const projectCap = layout.sections.projects.count, allProjects = !!q || sorting || !!expanded['projects:all'];
  const matchedProjects = projects.filter(p => !q || (byProject.get(p.id) ?? []).length || p.name.toLowerCase().includes(q));
  const pinnedCount = matchedProjects.filter(p => p.pinned).length;
  const cappedProjects = allProjects ? matchedProjects : matchedProjects.filter((p, i) => p.pinned || i - pinnedCount < projectCap || `p:${p.id}` === current);
  const projectGroups = cappedProjects.map(p => {
    const key = `p:${p.id}`, items = byProject.get(p.id) ?? [];
    const peers = projects.filter(item => !!item.pinned === !!p.pinned);
    const isCurrent = key === current, open = q ? true : toggled[key] ?? isCurrent;
    const dropCls = drag && drag.id !== p.id && drag.target === p.id ? (drag.after ? ' drop-after' : ' drop-before') : '';
    return <section key={key} className={`gah-group project${p.pinned ? ' pinned' : ''}${isCurrent ? ' current' : ''}${drag?.id === p.id ? ' dragging' : ''}${dropCls}`} data-key={key}>
      <div className={`gah-group-head${sorting ? ' sortable' : ''}`} {...(sorting ? {
        onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest('.gah-group-move')) return;
          e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); setDrag({ id: p.id, target: p.id, after: false });
        },
        onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => { if (!drag) return; const slot = dragSlot(e.clientX, e.clientY); if (slot && (slot.target !== drag.target || slot.after !== drag.after)) setDrag({ ...drag, ...slot }); },
        onPointerUp: () => { if (drag) dropProject(drag.id, drag.target, drag.after); setDrag(null); },
        onPointerCancel: () => setDrag(null),
      } : {})}><button type="button" className="gah-group-toggle" title={sorting ? T('\u62d6\u52a8\u4ee5\u6392\u5e8f', 'Drag to reorder') : p.workspace} aria-expanded={open} onClick={() => { if (!sorting) toggle(key, open); }}>{sorting && <span className="gah-group-grip" aria-hidden="true">{'\u2807'}</span>}<span className="gah-ico gah-ico-closed" data-i="folder" aria-hidden="true" /><span className="gah-ico gah-ico-open" data-i="folder-open" aria-hidden="true" /><span className="gah-group-name">{p.name}</span>{projectStatus.has(p.id) && <span className={`gah-sess-status ${projectStatus.get(p.id)}`} role="status" title={projectStatus.get(p.id) === 'cancelling' ? T('\u6709\u4f1a\u8bdd\u6b63\u5728\u505c\u6b62', 'A chat is stopping') : T('\u6709\u4f1a\u8bdd\u8fd0\u884c\u4e2d', 'A chat is running')} aria-label={projectStatus.get(p.id) === 'cancelling' ? T('\u6709\u4f1a\u8bdd\u6b63\u5728\u505c\u6b62', 'A chat is stopping') : T('\u6709\u4f1a\u8bdd\u8fd0\u884c\u4e2d', 'A chat is running')} />}<span className="gah-group-count">{(byProject.get(p.id) ?? []).length}</span></button>
        {sorting ? <><button type="button" className="gah-group-add gah-group-move" disabled={peers[0]?.id === p.id} aria-label={`${T('\u4e0a\u79fb', 'Move up')}: ${p.name}`} title={T('\u4e0a\u79fb', 'Move up')} onClick={() => moveProject(p.id, -1)}>{'\u25b2'}</button>
        <button type="button" className="gah-group-add gah-group-move" disabled={peers[peers.length - 1]?.id === p.id} aria-label={`${T('\u4e0b\u79fb', 'Move down')}: ${p.name}`} title={T('\u4e0b\u79fb', 'Move down')} onClick={() => moveProject(p.id, 1)}>{'\u25bc'}</button></> : <>
        <button type="button" className={`gah-group-add gah-project-pin${p.pinned ? ' on' : ''}`} disabled={busy} aria-pressed={!!p.pinned} aria-label={`${p.pinned ? T('\u53d6\u6d88\u9879\u76ee\u7f6e\u9876', 'Unpin project') : T('\u7f6e\u9876\u9879\u76ee', 'Pin project')}: ${p.name}`} title={p.pinned ? T('\u53d6\u6d88\u7f6e\u9876', 'Unpin') : T('\u7f6e\u9876', 'Pin')} onClick={() => void scoped({ action: p.pinned ? 'unpin' : 'pin', id: p.id }, false)}><Icon name="pin" /></button>
        <button type="button" className="gah-group-add" disabled={busy} data-gah-close="" aria-label={`${T('\u65b0\u5efa\u5bf9\u8bdd', 'New chat')}: ${p.name}`} onClick={() => void (isCurrent ? act('new', { project_id: p.id }) : scoped({ action: 'enter', id: p.id }))}><Icon name="plus" /></button>
        <button type="button" className="gah-group-add" disabled={busy} aria-label={`${T('\u9879\u76ee\u8bbe\u7f6e', 'Project settings')}: ${p.name}`} onClick={() => dialog('update', p.id)}><Icon name="pencil" /></button>
        <button type="button" className="gah-group-add" disabled={busy} aria-label={`${T('\u5220\u9664\u9879\u76ee', 'Delete project')}: ${p.name}`} onClick={async () => { if (await confirmDialog({ title: T('\u5220\u9664\u9879\u76ee', 'Delete project'), danger: true, confirm: T('\u5220\u9664', 'Delete'), message: T('\u5220\u9664\u9879\u76ee\u201c', 'Delete project "') + p.name + T('\u201d\uff1f\u5176\u4e2d\u7684\u4f1a\u8bdd\u4f1a\u79fb\u5230\u201c\u6700\u8fd1\u201d\uff0c\u9879\u76ee\u8bb0\u5fc6\u6587\u4ef6\u4fdd\u7559\u5728\u78c1\u76d8\u4e0a\u3002', '"? Its chats move to Recent; the project memory files stay on disk.') })) void scoped({ action: 'delete', id: p.id }, isCurrent); }}><Icon name="trash" /></button></>}</div>
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
      {key === 'projects' && <><div className="gah-sess-menu-sep" /><div className="gah-sess-menu-title">{T('\u9879\u76ee\u6392\u5e8f', 'Sort projects')}</div>
        {PROJECT_SORTS.map(k => <button key={k} type="button" role="menuitemradio" aria-checked={layout.projectSort === k} className={`gah-sess-menu-item${layout.projectSort === k ? ' on' : ''}`} onClick={pick(() => { if (k !== 'custom') setReordering(false); updateLayout(old => ({ ...old, projectSort: k, projectOrder: k === 'custom' && !old.projectOrder.length ? projects.map(p => p.id) : old.projectOrder })); })}>{(layout.projectSort === k ? '\u2713 ' : '\u3000') + sortName(k)}</button>)}
        <button type="button" role="menuitem" className="gah-sess-menu-item" disabled={!!q || projects.length < 2} onClick={pick(() => { if (sorting) { setReordering(false); return; } updateLayout(old => ({ ...old, projectSort: 'custom', projectOrder: projects.map(p => p.id) })); setReordering(true); if (!open) setSection('projects', { open: true }); })}>{sorting ? T('\u5b8c\u6210\u6392\u5e8f', 'Done reordering') : T('\u8c03\u6574\u9879\u76ee\u987a\u5e8f\u2026', 'Reorder projects\u2026')}</button></>}
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
        {sectionHead('projects', open, sorting ? <button type="button" className="gah-sess-head-btn gah-sess-done" aria-label={T('\u5b8c\u6210\u6392\u5e8f', 'Done reordering')} title={T('\u5b8c\u6210\u6392\u5e8f', 'Done reordering')} onClick={() => setReordering(false)}>{T('\u5b8c\u6210', 'Done')}</button> : <button type="button" className="gah-sess-head-btn" disabled={busy} aria-label={T('\u65b0\u5efa\u9879\u76ee', 'New project')} onClick={() => dialog('create')}><Icon name="folder-plus" /></button>)}
        {open && (projects.length ? <>{projectGroups}
          {!q && !sorting && matchedProjects.length - pinnedCount > projectCap && <button type="button" className="gah-sess-more" onClick={() => setExpanded(old => ({ ...old, 'projects:all': !allProjects }))}>{allProjects ? T('\u6536\u8d77\u9879\u76ee', 'Show fewer projects') : `${T('\u663e\u793a\u5168\u90e8\u9879\u76ee', 'Show all projects')} (${matchedProjects.length})`}</button>}</>
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
    <button type="button" className="side-item gah-sess-new" disabled={busy} title={T('\u65b0\u5efa\u672a\u7ed1\u5b9a\u9879\u76ee\u7684\u5bf9\u8bdd', 'New chat without a project')} data-gah-close="" onClick={() => void act('new')}><Icon name="pen" />{T('\u65b0\u4f1a\u8bdd', 'New chat')}</button><PageNav />
    <input type="search" className="gah-sess-search" value={query} placeholder={T('\u641c\u7d22\u4f1a\u8bdd', 'Search chats')} aria-label={T('\u641c\u7d22\u4f1a\u8bdd', 'Search chats')} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setQuery(''); }} />
    <div className="gah-sess-list" aria-label={T('\u4f1a\u8bdd\u5217\u8868', 'Chats')}>
      {scope ? <>
        {shownSections.map(key => sections[key]())}
        {!shownSections.length && <div className="gah-sess-empty">{T('\u6240\u6709\u5206\u533a\u5df2\u9690\u85cf', 'All sections are hidden')} <button type="button" className="gah-sess-more" onClick={() => updateLayout(old => ({ ...old, sections: Object.fromEntries(SECTION_KEYS.map(k => [k, { ...old.sections[k], show: true }])) as Layout['sections'] }))}>{T('\u5168\u90e8\u663e\u793a', 'Show all')}</button></div>}
      </> : <div className="gah-sess-items flat" role="list">{pinFirst((state.sessions ?? []).filter(s => !tucked(s) && (!q || label(s).toLowerCase().includes(q)))).map(s => row(s, 0))}</div>}
    </div></div></PluginSlot>;
}

defineReact('web-sessions', Sessions);
