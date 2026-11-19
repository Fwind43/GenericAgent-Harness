import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useHost, T, defineReact, pages, type HostState, type PluginAPI } from '@gah/sdk';

type Member = {
  name: string; role?: string; session?: string; groups?: string[]; model?: string | null; model_key?: string | null;
  effort?: string | null; status?: string; branch?: string | null; worktree?: string | null; removed?: boolean;
  runs?: number; started?: number | null; finished?: number | null; pending?: number; error?: string | null;
  brief?: string; elapsed?: number;
};
type Post = { id: number; author: string; text: string; created: number; mentions: string[]; kind: string; reply_to?: number; via?: string };
type Edge = { from: string; to: string; count: number };
type View = {
  id: string; me: string; enabled: boolean; finished?: unknown; paused?: unknown; coordinator: Member;
  members: Member[]; groups: Record<string, string[]>; posts: Post[]; total_posts: number; edges: Edge[]; wakes: number;
};
type Swarm = {
  enabled: string[]; members: Record<string, { swarm: string; name: string }>; current?: string;
  view?: View | null; limits?: Record<string, number>; running?: number; persistence_error?: string | null;
};

const COORD = 'coordinator';
const errText = (error: unknown) => String((error as Error)?.message || error);

function useSwarm(api: PluginAPI) {
  const { state } = useHost();
  const [busy, setBusy] = useState(false);
  const data = (state as unknown as { swarm?: Swarm }).swarm;
  const sid = state.session_id as string | undefined;
  const run = async (path: string, body: Record<string, unknown> = {}) => {
    if (!sid) return false;
    setBusy(true);
    try { await api.post(path, { session_id: sid, ...body }); return true; }
    catch (error) { api.notice(errText(error)); return false; }
    finally { setBusy(false); }
  };
  return { data, sid, busy, run };
}

const Icon = () => (
  <svg className="gah-sw-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
    <circle cx="8" cy="3.2" r="1.7" /><circle cx="3.2" cy="12" r="1.7" /><circle cx="12.8" cy="12" r="1.7" />
    <path d="M7 4.7 4.2 10.4M9 4.7l2.8 5.7M4.9 12h6.2" strokeLinecap="round" />
  </svg>
);
const Check = () => (
  <svg className="gah-menu-check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

const STATUS: Record<string, [string, string]> = {
  running: ['\u8fd0\u884c\u4e2d', 'Running'], queued: ['\u6392\u961f\u4e2d', 'Queued'], idle: ['\u7a7a\u95f2', 'Idle'],
  waiting: ['\u7b49\u5f85\u4e2d', 'Waiting'], error: ['\u51fa\u9519', 'Error'], removed: ['\u5df2\u79fb\u9664', 'Removed'],
};
const statusLabel = (s?: string) => { const v = STATUS[s || 'idle']; return v ? T(v[0], v[1]) : (s || ''); };
const fmtSecs = (s?: number) => s == null ? '' : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
const fmtTime = (t: number) => { const d = new Date(t * 1000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function Toggle({ api }: { api: PluginAPI }) {
  const { data, sid, busy, run } = useSwarm(api);
  if (!data || !sid || data.members?.[sid]) return null;
  const on = data.enabled.includes(sid);
  return (
    <button type="button" role="menuitemcheckbox" className="gah-menu-item" aria-checked={on} disabled={busy}
      onClick={() => run('toggle', { enabled: !on })}
      title={T('\u8702\u7fa4\u6a21\u5f0f\uff1a\u672c\u4f1a\u8bdd\u4f5c\u4e3a\u534f\u8c03\u8005\u7ec4\u5efa\u89d2\u8272\u56e2\u961f\uff0c\u6210\u5458\u5728\u5171\u4eab\u7559\u8a00\u677f\u4e0a\u4e92\u76f8 @ \u534f\u4f5c', 'Swarm mode: this session coordinates a team of roles that collaborate by @-mentioning each other on a shared board')}>
      <Icon /><span>{T('\u8702\u7fa4\u6a21\u5f0f', 'Swarm mode')}</span>
      {on ? <Check /> : null}
    </button>
  );
}

// Mentions graph: participants on a circle, arrows weighted by how often one @-ed the other.
function Graph({ view }: { view: View }) {
  const names = [COORD, ...view.members.filter(m => !m.removed).map(m => m.name)];
  for (const e of view.edges) for (const n of [e.from, e.to]) if (!names.includes(n)) names.push(n);
  const size = 300, c = size / 2, r = names.length > 1 ? size / 2 - 42 : 0;
  const pos: Record<string, [number, number]> = {};
  names.forEach((n, i) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / names.length; pos[n] = [c + r * Math.cos(a), c + r * Math.sin(a)]; });
  const max = Math.max(1, ...view.edges.map(e => e.count));
  const status: Record<string, string | undefined> = { [COORD]: view.coordinator?.status };
  view.members.forEach(m => { status[m.name] = m.removed ? 'removed' : m.status; });
  if (!view.edges.length) return <div className="gah-sw-empty">{T('\u8fd8\u6ca1\u6709 @ \u4e92\u52a8', 'No @-mentions yet')}</div>;
  return (
    <svg className="gah-sw-graph" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={T('@ \u5173\u7cfb\u56fe', 'Mention graph')}>
      <defs><marker id="gah-sw-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 8 4 0 8z" fill="currentColor" /></marker></defs>
      {view.edges.filter(e => pos[e.from] && pos[e.to] && e.from !== e.to).map(e => {
        const [x1, y1] = pos[e.from], [x2, y2] = pos[e.to];
        const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
        // offset sideways so a<->b pairs draw as two separate arrows
        const ox = -uy * 4, oy = ux * 4, pad = 20;
        return (
          <g key={`${e.from}>${e.to}`} className="gah-sw-edge">
            <line x1={x1 + ux * pad + ox} y1={y1 + uy * pad + oy} x2={x2 - ux * pad + ox} y2={y2 - uy * pad + oy}
              strokeWidth={1 + (3 * e.count) / max} markerEnd="url(#gah-sw-arrow)"><title>{`@${e.from} \u2192 @${e.to} \u00d7${e.count}`}</title></line>
          </g>
        );
      })}
      {names.map(n => (
        <g key={n} className={`gah-sw-node ${status[n] || 'idle'}`} transform={`translate(${pos[n][0]},${pos[n][1]})`}>
          <circle r="16" /><text y="4" textAnchor="middle">{n === COORD ? '\u2605' : n === 'user' ? 'U' : n.slice(0, 2)}</text>
          <text className="gah-sw-label" y="30" textAnchor="middle">@{n}</text>
        </g>
      ))}
    </svg>
  );
}

function PostRow({ post }: { post: Post }) {
  const [open, setOpen] = useState(false);
  const long = post.text.length > 280 || post.text.split('\n').length > 6;
  const parts = post.text.split(/(@[a-z0-9_-]+)/gi);
  return (
    <div className={`gah-sw-post ${post.kind}${post.author === 'user' ? ' user' : ''}`}>
      <div className="gah-sw-meta">
        <b>@{post.author}</b><span>#{post.id}</span>{post.reply_to ? <span>{'\u21aa'} #{post.reply_to}</span> : null}
        {post.via ? <span title={T('\u6765\u81ea\u975e\u8702\u7fa4\u8c03\u5ea6\u7684\u8fd0\u884c', 'Posted from a run not scheduled by the swarm')}>{post.via}</span> : null}
        <span className="gah-sw-time">{fmtTime(post.created)}</span>
      </div>
      <div className={`gah-sw-text${long && !open ? ' clamp' : ''}`}>
        {parts.map((p, i) => p.startsWith('@') ? <span key={i} className="gah-sw-at">{p}</span> : p)}
      </div>
      {long ? <button type="button" className="gah-sw-more" onClick={() => setOpen(!open)}>{open ? T('\u6536\u8d77', 'Less') : T('\u5c55\u5f00', 'More')}</button> : null}
    </div>
  );
}

function Board({ api, view, run, busy }: { api: PluginAPI; view: View; run: (p: string, b?: Record<string, unknown>) => Promise<boolean>; busy: boolean }) {
  const [text, setText] = useState('');
  const [older, setOlder] = useState<Post[]>([]);
  const [loading, setLoading] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const { state } = useHost();
  const posts = [...older.filter(p => !view.posts.some(q => q.id === p.id)), ...view.posts];
  const last = view.posts[view.posts.length - 1]?.id;
  useEffect(() => { setOlder([]); }, [view.id]);
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [last]);
  const more = async () => {
    if (!posts.length || loading) return;
    setLoading(true);
    try {
      const res = await api.post<{ posts: Post[] }>('board', { session_id: state.session_id, before: posts[0].id });
      setOlder(o => [...(res.posts || []), ...o]);
    } catch (error) { api.notice(errText(error)); }
    finally { setLoading(false); }
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    if (await run('post', { text: value })) setText('');
  };
  return (
    <>
      <div className="gah-sw-board" ref={list}>
        {posts.length && posts[0].id > 1 ? <button type="button" className="gah-sw-more" disabled={loading} onClick={more}>{T('\u52a0\u8f7d\u66f4\u65e9\u7684\u5e16\u5b50', 'Load earlier posts')}</button> : null}
        {posts.length ? posts.map(p => <PostRow key={p.id} post={p} />) : <div className="gah-sw-empty">{T('\u7559\u8a00\u677f\u8fd8\u662f\u7a7a\u7684', 'The board is empty')}</div>}
      </div>
      {!view.finished ? (
        <form className="gah-sw-compose" onSubmit={send}>
          <input value={text} onChange={e => setText(e.target.value)} disabled={busy} maxLength={8000}
            placeholder={T('\u4ee5 @user \u8eab\u4efd\u53d1\u5e16\uff0c@\u540d\u5b57 / @\u7ec4 / @all \u53ef\u5524\u9192\u6210\u5458', 'Post as @user; @name / @group / @all wakes members')} />
          <button type="submit" disabled={busy || !text.trim()}>{T('\u53d1\u9001', 'Post')}</button>
        </form>
      ) : null}
    </>
  );
}

function MemberRow({ m, me, busy, act, enter }: {
  m: Member; me: string; busy: boolean; act: (path: string, m: Member) => void; enter: (m: Member) => void;
}) {
  const [open, setOpen] = useState(false);
  const st = m.removed ? 'removed' : m.status || 'idle';
  const detail = [m.role, m.model || T('\u9ed8\u8ba4\u6a21\u578b', 'Default model'), m.effort, m.branch && `\u2387 ${m.branch}`].filter(Boolean).join(' \u00b7 ');
  return (
    <div className={`gah-sw-member${m.removed ? ' removed' : ''}${m.name === me ? ' me' : ''}`}>
      <div className="gah-sw-row">
        <button type="button" className="gah-sw-name" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={`gah-sw-dot ${st}`} aria-hidden="true" />
          <b>@{m.name}</b>
          {m.groups?.length ? <span className="gah-sw-groups">{m.groups.map(g => `@${g}`).join(' ')}</span> : null}
          <span className="gah-sw-detail">{detail}</span>
        </button>
        <span className="gah-sw-st">{statusLabel(st)}{st === 'running' && m.elapsed != null ? ` ${fmtSecs(m.elapsed)}` : ''}{m.pending ? ` +${m.pending}` : ''}</span>
        {m.session && m.name !== me ? <button type="button" className="gah-sw-act" title={T('\u6253\u5f00\u8be5\u6210\u5458\u4f1a\u8bdd\uff08\u79c1\u804a\u4e0d\u4f1a\u53d1\u5230\u7559\u8a00\u677f\uff09', 'Open member session (private chat stays off the board)')} onClick={() => enter(m)}>{'\u2197'}</button> : null}
        {st === 'running' ? <button type="button" className="gah-sw-act" disabled={busy} title={T('\u505c\u6b62\u5f53\u524d\u8fd0\u884c', 'Stop current run')} onClick={() => act('cancel', m)}>{'\u25a0'}</button> : null}
        {!m.removed && m.name !== COORD ? <button type="button" className="gah-sw-act" disabled={busy} title={T('\u79fb\u51fa\u8702\u7fa4', 'Remove from swarm')} onClick={() => act('remove', m)}>{'\u00d7'}</button> : null}
      </div>
      {open ? (
        <div className="gah-sw-brief">
          {m.brief ? <div>{m.brief}</div> : null}
          <div className="gah-sw-facts">
            {T('\u8fd0\u884c', 'Runs')} {m.runs || 0}
            {m.worktree ? <> {'\u00b7'} <code title={m.worktree}>{m.worktree}</code></> : null}
          </div>
          {m.error ? <div className="gah-sw-err">{m.error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function Panel({ api }: { api: PluginAPI }) {
  const { data, sid, busy, run } = useSwarm(api);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'board' | 'members' | 'graph'>('board');
  const box = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      const el = pop.current;
      if (!el) return;
      el.style.transform = '';
      const rect = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const pad = 12;
      let dx = 0;
      if (rect.left < pad) dx = pad - rect.left;
      else if (rect.right > vw - pad) dx = vw - pad - rect.right;
      if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (event: Event) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('touchstart', down); document.removeEventListener('keydown', key); };
  }, [open]);
  useEffect(() => { setOpen(false); }, [sid]);
  const view = data?.view;
  if (!data || !sid || !view) return null;
  const isCoord = view.me === COORD;
  const live = view.members.filter(m => !m.removed);
  const running = live.filter(m => m.status === 'running').length + (view.coordinator?.status === 'running' ? 1 : 0);
  const act = async (path: string, m: Member) => {
    if (path === 'remove' && !window.confirm(T(`\u786e\u5b9a\u628a @${m.name} \u79fb\u51fa\u8702\u7fa4\uff1f`, `Remove @${m.name} from the swarm?`))) return;
    await run(path, { name: m.name });
  };
  const enter = async (m: Member) => {
    if (!m.session) return;
    setOpen(false);
    try { api.setState(await api.host.post<HostState>('/api/sessions', { action: 'select', id: m.session }), true); pages.home(); }
    catch (error) { api.notice(errText(error)); }
  };
  const label = isCoord ? T('\u8702\u7fa4', 'Swarm') : `@${view.me}`;
  const state = view.finished ? T('\u5df2\u7ed3\u675f', 'Finished') : view.paused ? T('\u5df2\u6682\u505c', 'Paused') : !view.enabled ? T('\u5df2\u5173\u95ed', 'Off') : '';
  return (
    <div className="gah-sw-anchor" ref={box}>
      <button type="button" className={`gah-sw-chip${view.enabled && !view.finished ? ' on' : ''}${open ? ' open' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}
        title={isCoord ? T('\u8702\u7fa4\u6a21\u5f0f\uff1a\u672c\u4f1a\u8bdd\u662f\u534f\u8c03\u8005', 'Swarm mode: this session is the coordinator') : T('\u672c\u4f1a\u8bdd\u662f\u8702\u7fa4\u6210\u5458\uff1b\u5728\u8fd9\u91cc\u79c1\u804a\u4e0d\u4f1a\u53d1\u5230\u7559\u8a00\u677f', 'This session is a swarm member; chatting here stays off the board')}>
        <Icon /><span>{label}</span>
        <span className="gah-sw-count">{running ? `${running}/${live.length + 1}` : live.length + 1}</span>
        {state ? <span className="gah-sw-state">{state}</span> : null}
        <svg className="gah-sw-caret" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
      </button>
      {open ? (
        <div className="gah-sw" ref={pop} role="dialog" aria-label={T('\u8702\u7fa4', 'Swarm')}>
          <div className="gah-sw-bar">
            <div className="gah-sw-tabs" role="tablist">
              {(['board', 'members', 'graph'] as const).map(k => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                  {k === 'board' ? `${T('\u7559\u8a00\u677f', 'Board')} ${view.total_posts}` : k === 'members' ? `${T('\u6210\u5458', 'Members')} ${live.length}` : T('\u5173\u7cfb', 'Graph')}
                </button>
              ))}
            </div>
            {view.paused && !view.finished ? <button type="button" className="gah-sw-off" disabled={busy} onClick={() => run('resume')} title={String(view.paused)}>{T('\u7ee7\u7eed', 'Resume')}</button> : null}
            {isCoord ? <button type="button" className="gah-sw-off" disabled={busy} onClick={() => run('toggle', { enabled: !view.enabled || !!view.finished })}>
              {view.enabled && !view.finished ? T('\u5173\u95ed', 'Turn off') : T('\u91cd\u65b0\u5f00\u542f', 'Turn on')}
            </button> : null}
          </div>
          {view.paused && !view.finished ? <div className="gah-sw-note">{T('\u5df2\u6682\u505c\u81ea\u52a8\u5524\u9192\uff1a', 'Auto-wake paused: ')}{String(view.paused)}</div> : null}
          {view.finished ? <div className="gah-sw-note">{T('\u534f\u8c03\u8005\u5df2\u5ba3\u5e03\u7ed3\u675f\uff1a', 'Coordinator finished: ')}{typeof view.finished === 'string' ? view.finished : ''}</div> : null}
          {data.persistence_error ? <div className="gah-sw-note err">{data.persistence_error}</div> : null}
          {tab === 'board' ? <Board api={api} view={view} run={run} busy={busy} /> : null}
          {tab === 'members' ? (
            <div className="gah-sw-list">
              <MemberRow m={{ ...view.coordinator, name: COORD, role: T('\u534f\u8c03\u8005', 'Coordinator') }} me={view.me} busy={busy} act={act} enter={enter} />
              {view.members.map(m => <MemberRow key={m.name} m={m} me={view.me} busy={busy} act={act} enter={enter} />)}
              {!live.length ? <div className="gah-sw-empty">{T('\u534f\u8c03\u8005\u4f1a\u7528 swarm_add \u62db\u52df\u6210\u5458', 'The coordinator recruits members with swarm_add')}</div> : null}
              {data.limits ? <div className="gah-sw-facts">{T('\u5168\u5c40\u8fd0\u884c', 'Running globally')} {data.running ?? 0}{data.limits.global_max ? ` / ${data.limits.global_max}` : ''}</div> : null}
            </div>
          ) : null}
          {tab === 'graph' ? <Graph view={view} /> : null}
        </div>
      ) : null}
    </div>
  );
}

// "/swarm" (on), "/swarm off", "/swarm resume", "/swarm <text>" (post to the board as @user).
function Slash({ api }: { api: PluginAPI }) {
  const { data, sid, run } = useSwarm(api);
  useEffect(() => api.intercept(text => {
    const match = /^\/swarm(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (!match || !sid || !data) return false;
    const arg = (match[1] || '').trim();
    const low = arg.toLowerCase();
    const view = data.view;
    if (!arg || low === 'on') void run('toggle', { enabled: true });
    else if (low === 'off' || low === T('\u5173\u95ed', 'off')) void run('toggle', { enabled: false });
    else if (low === 'resume') void run('resume');
    else if (!view) throw new Error(T('\u5f53\u524d\u4f1a\u8bdd\u4e0d\u5728\u8702\u7fa4\u4e2d\uff0c\u5148\u7528 /swarm \u5f00\u542f', 'This session is not in a swarm; start one with /swarm'));
    else void run('post', { text: arg });
    return true;
  }), [api, sid, data]);
  return null;
}

function SwarmPlugin({ api }: { api: PluginAPI }) {
  useEffect(() => api.mount('composer-menu', <Toggle api={api} />), [api]);
  useEffect(() => api.mount('header', <Panel api={api} />), [api]);
  return <Slash api={api} />;
}

defineReact('swarm', SwarmPlugin);
