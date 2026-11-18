import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type PluginAPI, PluginSlot, Icon, T, errorText, defineReact, useHost } from '@gah/sdk';

// Right-hand workbench: file tree, file viewer/editor and Git changes for the current chat's
// workspace, backed by /api/p/web-sidebar/{tree,file,search,git,diff}.
// Inspired by omdsh-dev/DSH-better-sidebar (MIT); see NOTICE.md.
type Entry = { name: string; type: 'dir' | 'file'; size: number; status: string };
type Tree = { root: string; path: string; git: boolean; entries: Entry[]; truncated: boolean };
type FileData = { path: string; abs: string; kind: 'text' | 'image' | 'binary'; size: number; mtime: string; text: string; eol: string; bom: boolean; truncated: boolean };
type Saved = { path: string; size: number; mtime: string };
type GitData = { git: boolean; branch: string; files: { path: string; status: string }[] };
type DiffData = { path: string; diff: string; truncated: boolean };
type BrowsingRoot = { sid: string; root: 'auto' | 'workspace' | 'project'; project_id: string };
type View = { kind: 'file' | 'diff'; path: string; rootKey: string };
type LeaveGuard = { current: (() => boolean) | null };

const K_OPEN = 'gah.web-sidebar.open', K_WIDTH = 'gah.web-sidebar.width', K_WRAP = 'gah.web-sidebar.wrap';
const MIN_W = 260, MAX_W = 960;
const load = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };
const clampW = (w: number) => Math.round(Math.max(MIN_W, Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - 320), w)));
const qs = (args: Record<string, string>) => Object.entries(args).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const baseName = (path: string) => path.replace(/\/$/, '').split('/').pop() || path;
const dirName = (path: string) => { const p = path.replace(/\/$/, ''); const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const fmtSize = (n: number) => n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
const STATUS: Record<string, string> = { M: 'm', T: 'm', A: 'a', C: 'a', R: 'r', D: 'd', U: 'c', '?': 'u' };
const statusClass = (code: string) => code ? ' st-' + (STATUS[code] || 'm') : '';
const statusTitle = (code: string) => ({
  m: T('\u5df2\u4fee\u6539', 'Modified'), a: T('\u5df2\u6dfb\u52a0', 'Added'), r: T('\u5df2\u91cd\u547d\u540d', 'Renamed'),
  d: T('\u5df2\u5220\u9664', 'Deleted'), c: T('\u51b2\u7a81', 'Conflict'), u: T('\u672a\u8ddf\u8e2a', 'Untracked'),
})[STATUS[code] || 'm'] || '';
const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

function Badge({ code }: { code: string }) {
  return code ? <span className={'gah-sb-badge' + statusClass(code)} title={statusTitle(code)}>{code === '?' ? 'U' : code}</span> : null;
}

function Files({ api, root, tick, active, onOpen }: { api: PluginAPI; root: BrowsingRoot; tick: number; active: string; onOpen: (path: string) => void }) {
  const [dirs, setDirs] = useState<Record<string, Tree>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ files: string[]; truncated: boolean } | null>(null);
  const live = useRef<BrowsingRoot | null>(root), opened = useRef(expanded);
  opened.current = expanded;
  useEffect(() => { live.current = root; return () => { live.current = null; }; }, [root]);

  const fetchDir = useCallback((path: string) => api.get<Tree>('tree?' + qs({ ...root, path })).then(tree => {
    if (live.current === root) setDirs(prev => ({ ...prev, [path]: tree }));
  }), [api, root]);

  // The parent keys the tree by browsing root; refresh only reloads expanded directories.
  useEffect(() => {
    setError('');
    fetchDir('').catch(e => { if (live.current === root) { setDirs({}); setError(errorText(e)); } });
    opened.current.forEach(path => {
      fetchDir(path).catch(() => {
        if (live.current === root) setExpanded(prev => { const next = new Set(prev); next.delete(path); return next; });
      });
    });
  }, [fetchDir, root, tick]);

  useEffect(() => {
    const text = query.trim();
    if (!text) { setFound(null); return; }
    let stale = false;
    const timer = window.setTimeout(() => {
      api.get<{ files: string[]; truncated: boolean }>('search?' + qs({ ...root, q: text }))
        .then(result => { if (!stale) setFound(result); })
        .catch(e => { if (!stale) { setFound({ files: [], truncated: false }); setError(errorText(e)); } });
    }, 250);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [api, root, query, tick]);

  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else { next.add(path); fetchDir(path).catch(e => setError(errorText(e))); }
    setExpanded(next);
  };

  const rows = (path: string, depth: number): ReactNode[] => {
    const tree = dirs[path];
    if (!tree) return [<div key={path + '/…'} className="gah-sb-note" style={{ paddingLeft: 12 + depth * 14 }}>{T('\u52a0\u8f7d\u4e2d\u2026', 'Loading…')}</div>];
    const out: ReactNode[] = [];
    for (const entry of tree.entries) {
      const full = path ? `${path}/${entry.name}` : entry.name;
      const isDir = entry.type === 'dir', isOpen = isDir && expanded.has(full);
      out.push(<button type="button" key={full} title={full}
        className={'gah-sb-row' + statusClass(entry.status) + (!isDir && full === active ? ' on' : '')}
        style={{ paddingLeft: 8 + depth * 14 }} aria-expanded={isDir ? isOpen : undefined}
        onClick={() => isDir ? toggle(full) : onOpen(full)}>
        <span className={'gah-sb-twist' + (isOpen ? ' open' : '')}>{isDir ? '\u203a' : ''}</span>
        {isDir ? <Icon name={isOpen ? 'folder-open' : 'folder'} /> : null}
        <span className="name">{entry.name}</span><Badge code={entry.status} />
      </button>);
      if (isOpen) out.push(...rows(full, depth + 1));
    }
    if (tree.truncated) out.push(<div key={path + '/+'} className="gah-sb-note" style={{ paddingLeft: 12 + depth * 14 }}>{T('\u76ee\u5f55\u8fc7\u5927\uff0c\u4ec5\u663e\u793a\u524d 2000 \u9879', 'Large directory: first 2000 entries shown')}</div>);
    if (!tree.entries.length) out.push(<div key={path + '/0'} className="gah-sb-note" style={{ paddingLeft: 12 + depth * 14 }}>{T('\u7a7a\u76ee\u5f55', 'Empty')}</div>);
    return out;
  };

  const tree = dirs[''];
  return <div className="gah-sb-pane">
    <div className="gah-sb-search"><input type="search" value={query} placeholder={T('\u641c\u7d22\u6587\u4ef6\u540d\u2026', 'Search files…')}
      aria-label={T('\u641c\u7d22\u6587\u4ef6', 'Search files')} onChange={event => setQuery(event.target.value)} /></div>
    {tree ? <div className="gah-sb-root" title={tree.root}>{tree.root}</div> : null}
    {error ? <div className="gah-sb-error">{error}</div> : null}
    <div className="gah-sb-list">
      {found ? <>
        {found.files.map(path => <button type="button" key={path} title={path} className={'gah-sb-row hit' + (path === active ? ' on' : '')} onClick={() => onOpen(path)}>
          <span className="name">{baseName(path)}</span><span className="dir">{dirName(path)}</span>
        </button>)}
        {!found.files.length ? <div className="gah-sb-note">{T('\u6ca1\u6709\u5339\u914d\u7684\u6587\u4ef6', 'No matching files')}</div> : null}
        {found.truncated ? <div className="gah-sb-note">{T('\u7ed3\u679c\u5df2\u622a\u65ad\uff0c\u8bf7\u7f29\u5c0f\u8303\u56f4', 'Results truncated; refine the search')}</div> : null}
      </> : error && !tree ? null : rows('', 0)}
    </div>
  </div>;
}

function Changes({ api, root, tick, active, onOpen }: { api: PluginAPI; root: BrowsingRoot; tick: number; active: string; onOpen: (path: string) => void }) {
  const [data, setData] = useState<GitData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stale = false;
    setError('');
    api.get<GitData>('git?' + qs(root)).then(result => { if (!stale) setData(result); })
      .catch(e => { if (!stale) { setData(null); setError(errorText(e)); } });
    return () => { stale = true; };
  }, [api, root, tick]);
  return <div className="gah-sb-pane">
    {data?.git ? <div className="gah-sb-root"><b>{data.branch || 'HEAD'}</b> · {T(`${data.files.length} \u5904\u53d8\u66f4`, `${data.files.length} changed`)}</div> : null}
    {error ? <div className="gah-sb-error">{error}</div> : null}
    <div className="gah-sb-list">
      {data && !data.git ? <div className="gah-sb-note">{T('\u5f53\u524d\u5de5\u4f5c\u533a\u4e0d\u662f Git \u4ed3\u5e93', 'This workspace is not a Git repository')}</div> : null}
      {data?.git && !data.files.length ? <div className="gah-sb-note">{T('\u5de5\u4f5c\u533a\u5e72\u51c0\uff0c\u6ca1\u6709\u53d8\u66f4', 'Working tree clean')}</div> : null}
      {data?.files.map(file => {
        const isDir = file.path.endsWith('/');
        return <button type="button" key={file.path} title={file.path} disabled={isDir}
          className={'gah-sb-row hit' + statusClass(file.status) + (file.path === active ? ' on' : '')} onClick={() => onOpen(file.path)}>
          <span className="name">{baseName(file.path) + (isDir ? '/' : '')}</span><span className="dir">{dirName(file.path)}</span><Badge code={file.status} />
        </button>;
      })}
    </div>
  </div>;
}

function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const output = (window as unknown as { GAHOutput?: { setMarkdown?: (node: HTMLElement, text: string) => void } }).GAHOutput;
    if (output?.setMarkdown) output.setMarkdown(node, text); else node.textContent = text;
  }, [text]);
  return <div ref={ref} className="gah-sb-md md" />;
}

function FileView({ api, root, path, tick, leaveGuard, onClose }: { api: PluginAPI; root: BrowsingRoot; path: string; tick: number; leaveGuard: LeaveGuard; onClose: () => void }) {
  const [data, setData] = useState<FileData | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<string | null>(null);   // non-null while editing
  const [saving, setSaving] = useState(false);
  const [raw, setRaw] = useState(false);
  const [wrap, setWrap] = useState(() => load(K_WRAP) !== '0');
  const editing = useRef(false);
  editing.current = draft !== null;
  const dirty = draft !== null && data !== null && draft !== data.text;
  const canLeave = useCallback(() => !saving && (!dirty || window.confirm(T('\u653e\u5f03\u672a\u4fdd\u5b58\u7684\u4fee\u6539\uff1f', 'Discard unsaved changes?'))), [dirty, saving]);

  useEffect(() => {
    leaveGuard.current = canLeave;
    return () => { if (leaveGuard.current === canLeave) leaveGuard.current = null; };
  }, [leaveGuard, canLeave]);
  useEffect(() => { store(K_WRAP, wrap ? '1' : '0'); }, [wrap]);
  useEffect(() => { setData(null); setDraft(null); setRaw(false); }, [root, path]);
  useEffect(() => {
    if (editing.current) return;   // never replace text under the user's cursor
    let stale = false;
    setError('');
    api.get<FileData>('file?' + qs({ ...root, path })).then(result => { if (!stale && !editing.current) setData(result); })
      .catch(e => { if (!stale) setError(errorText(e)); });
    return () => { stale = true; };
  }, [api, root, path, tick]);

  const save = () => {
    if (!data || draft === null || saving) return;
    setSaving(true); setError('');
    api.post<Saved>('file', { ...root, path, text: draft, mtime: data.mtime, eol: data.eol, bom: data.bom })
      .then(result => { setData({ ...data, text: draft, mtime: result.mtime, size: result.size }); setDraft(null); })
      .catch(e => setError(errorText(e)))
      .finally(() => setSaving(false));
  };
  const leave = (then: () => void) => { if (canLeave()) then(); };
  const markdown = isMarkdown(path) && !raw;
  const editable = data?.kind === 'text' && !data.truncated;

  return <div className="gah-sb-view">
    <div className="gah-sb-vhead">
      <span className="name" title={data?.abs || path}>{baseName(path)}{dirty ? ' \u25cf' : ''}</span>
      {data ? <span className="meta">{fmtSize(data.size)}</span> : null}
      <span className="spacer" />
      {data?.kind === 'text' && (draft !== null || !markdown) ? <button type="button" className={'gah-sb-btn' + (wrap ? ' on' : '')}
        aria-pressed={wrap} title={T('\u81ea\u52a8\u6362\u884c', 'Word wrap')} onClick={() => setWrap(value => !value)}>{T('\u81ea\u52a8\u6362\u884c', 'Word wrap')}</button> : null}
      {draft === null && data?.kind === 'text' && isMarkdown(path) ? <button type="button" className="gah-sb-btn" onClick={() => setRaw(!raw)}>{raw ? T('\u9884\u89c8', 'Preview') : T('\u6e90\u7801', 'Source')}</button> : null}
      {draft === null && editable ? <button type="button" className="gah-sb-btn" onClick={() => setDraft(data!.text)}>{T('\u7f16\u8f91', 'Edit')}</button> : null}
      {draft !== null ? <>
        <button type="button" className="gah-sb-btn" disabled={saving} onClick={() => leave(() => setDraft(null))}>{T('\u53d6\u6d88', 'Cancel')}</button>
        <button type="button" className="gah-sb-btn primary" disabled={saving || !dirty} onClick={save}>{saving ? T('\u4fdd\u5b58\u4e2d\u2026', 'Saving…') : T('\u4fdd\u5b58', 'Save')}</button>
      </> : null}
      <button type="button" className="gah-icon-btn" aria-label={T('\u5173\u95ed\u6587\u4ef6', 'Close file')} title={T('\u5173\u95ed\u6587\u4ef6', 'Close file')} onClick={() => leave(onClose)}><Icon name="x" /></button>
    </div>
    {error ? <div className="gah-sb-error">{error}</div> : null}
    {!data ? (error ? null : <div className="gah-sb-note">{T('\u52a0\u8f7d\u4e2d\u2026', 'Loading…')}</div>)
      : data.kind === 'image' ? <div className="gah-sb-image"><img src={api.fileURL(data.abs)} alt={baseName(path)} /></div>
      : data.kind === 'binary' ? <div className="gah-sb-note">{T('\u4e8c\u8fdb\u5236\u6216\u975e UTF-8 \u6587\u4ef6\uff0c\u65e0\u6cd5\u9884\u89c8', 'Binary or non-UTF-8 file; no preview')}</div>
      : draft !== null ? <textarea className={"gah-sb-edit" + (wrap ? " gah-sb-wrap" : "")} wrap={wrap ? "soft" : "off"} value={draft} spellCheck={false} autoFocus disabled={saving}
          aria-label={T('\u7f16\u8f91\u6587\u4ef6', 'Edit file')} onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
            if (event.key === 'Tab' && !event.shiftKey) {
              event.preventDefault();
              const area = event.currentTarget, at = area.selectionStart;
              area.setRangeText('  ', at, area.selectionEnd, 'end');
              setDraft(area.value);
            }
          }} />
      : <>
        {data.truncated ? <div className="gah-sb-note">{T('\u6587\u4ef6\u8d85\u8fc7 1 MB\uff0c\u4ec5\u663e\u793a\u5f00\u5934\u4e14\u4e0d\u53ef\u7f16\u8f91', 'File exceeds 1 MB: showing the beginning, read-only')}</div> : null}
        {markdown ? <Markdown text={data.text} /> : <pre className={"gah-sb-code" + (wrap ? " gah-sb-wrap" : "")}>{data.text}</pre>}
      </>}
  </div>;
}

function DiffView({ api, root, path, tick, onClose }: { api: PluginAPI; root: BrowsingRoot; path: string; tick: number; onClose: () => void }) {
  const [data, setData] = useState<DiffData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stale = false;
    setError('');
    api.get<DiffData>('diff?' + qs({ ...root, path })).then(result => { if (!stale) setData(result); })
      .catch(e => { if (!stale) { setData(null); setError(errorText(e)); } });
    return () => { stale = true; };
  }, [api, root, path, tick]);
  const kind = (line: string) => line.startsWith('@@') ? ' hunk' : /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line) ? ' meta'
    : line.startsWith('+') ? ' add' : line.startsWith('-') ? ' del' : '';
  return <div className="gah-sb-view">
    <div className="gah-sb-vhead">
      <span className="name" title={path}>{baseName(path)}</span><span className="meta">diff</span><span className="spacer" />
      <button type="button" className="gah-icon-btn" aria-label={T('\u5173\u95ed', 'Close')} title={T('\u5173\u95ed', 'Close')} onClick={onClose}><Icon name="x" /></button>
    </div>
    {error ? <div className="gah-sb-error">{error}</div> : null}
    {!data ? (error ? null : <div className="gah-sb-note">{T('\u52a0\u8f7d\u4e2d\u2026', 'Loading…')}</div>)
      : !data.diff ? <div className="gah-sb-note">{T('\u6ca1\u6709\u6587\u672c\u5dee\u5f02', 'No textual changes')}</div>
      : <pre className="gah-sb-diff">{data.diff.replace(/\n$/, '').split('\n').map((line, i) => <span key={i} className={'l' + kind(line)}>{line || ' '}{'\n'}</span>)}
        {data.truncated ? <span className="l meta">{T('\u2026 diff \u8fc7\u957f\uff0c\u5df2\u622a\u65ad', '… diff truncated')}</span> : null}</pre>}
  </div>;
}

function Sidebar({ api }: { api: PluginAPI }) {
  const { state } = useHost();
  const sid = state.session_id || '';
  const scope = state.scope;
  const running = !!state.running;
  const [open, setOpen] = useState(() => load(K_OPEN) === '1');
  const [tab, setTab] = useState<'files' | 'git'>('files');
  const [width, setWidth] = useState(() => clampW(Number(load(K_WIDTH)) || 400));
  const [view, setView] = useState<View | null>(null);
  const [selection, setSelection] = useState<BrowsingRoot | null>(null);
  const [tick, setTick] = useState(0);
  const wasRunning = useRef(running);
  const leaveGuard = useRef<(() => boolean) | null>(null);
  // Never render the previous chat's browser state while waiting for effects.
  const root = useMemo<BrowsingRoot>(() => selection?.sid === sid ? selection : { sid, root: 'auto', project_id: '' }, [selection, sid]);
  const project = root.project_id ? scope?.projects.find(p => p.id === root.project_id) : scope?.project;
  const projectId = root.project_id || project?.id || '';
  const rootKey = JSON.stringify([root, scope?.workspace, scope?.default_workspace, project?.id, project?.name, project?.workspace]);
  const activeView = view?.rootKey === rootKey ? view : null;
  const canLeave = useCallback(() => leaveGuard.current?.() ?? true, []);
  const selectRoot = useCallback((mode: BrowsingRoot['root'], projectId = '') => {
    if (!canLeave()) return;
    setSelection({ sid, root: mode, project_id: mode === 'project' ? projectId : '' });
    setView(null); setTab('files'); setOpen(true);
  }, [sid, canLeave]);
  const selectTab = (next: 'files' | 'git') => {
    if (next === tab || !canLeave()) return;
    setView(null); setTab(next);
  };
  const openView = (kind: View['kind'], path: string) => {
    if (activeView?.kind === kind && activeView.path === path) return;
    if (canLeave()) setView({ kind, path, rootKey });
  };
  const toggleOpen = () => {
    if (open && !canLeave()) return;
    if (open) setView(null);
    setOpen(!open);
  };

  // Clicking a text/code reference in a chat message opens it here when it lies under the
  // current browsing root; anything else (media, PDFs, outside files, modified clicks) keeps
  // the host's default (lightbox or new tab).
  const nav = useRef({ root, rootKey, canLeave, activeView });
  nav.current = { root, rootKey, canLeave, activeView };
  useEffect(() => api.openFile(async (ref, event) => {
    if (event && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button === 1)) return false;
    if ((ref.kind !== 'code' && ref.kind !== 'doc') || ref.ext === 'pdf') return false;
    const start = nav.current;
    if (!start.root.sid) return false;
    let abs = '', base = '';
    try {
      const [info, tree] = await Promise.all([
        api.host.get<{ path: string }>(api.fileURL(ref.path, { info: true })),
        api.get<Tree>('tree?' + qs({ ...start.root, path: '' })),
      ]);
      abs = info.path; base = tree.root;
    } catch { return false; }
    const now = nav.current;
    if (now.rootKey !== start.rootKey) return false;
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const fold = (p: string) => /^[A-Za-z]:/.test(p) ? p.toLowerCase() : p;   // Windows paths are case-insensitive
    abs = norm(abs); base = norm(base);
    if (!abs || !base || !fold(abs).startsWith(fold(base) + '/')) return false;
    const rel = abs.slice(base.length + 1);
    const same = now.activeView?.kind === 'file' && now.activeView.path === rel;
    if (!same && !now.canLeave()) return true;   // the user chose to keep unsaved edits
    if (!same) setView({ kind: 'file', path: rel, rootKey: now.rootKey });
    setTab('files'); setOpen(true);
    return true;
  }), [api]);

  useEffect(() => { store(K_OPEN, open ? '1' : '0'); }, [open]);
  useEffect(() => { setSelection(null); }, [sid]);
  useEffect(() => { setView(null); }, [rootKey]);
  useEffect(() => {
    const openProject = (event: Event) => {
      const pid = (event as CustomEvent<{ project_id?: unknown }>).detail?.project_id;
      if (typeof pid === 'string' && pid) selectRoot('project', pid);
    };
    window.addEventListener('gah:sidebar-open-project', openProject);
    return () => window.removeEventListener('gah:sidebar-open-project', openProject);
  }, [selectRoot]);
  // The agent edits files while it runs: refresh once each run ends.
  useEffect(() => { if (wasRunning.current && !running) setTick(t => t + 1); wasRunning.current = running; }, [running]);
  useEffect(() => {
    if (!open) return;
    const fit = () => setWidth(w => clampW(w));
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open]);

  const drag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    let last = width;
    const move = (e: PointerEvent) => { last = clampW(window.innerWidth - e.clientX); setWidth(last); };
    const up = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
      store(K_WIDTH, String(last));
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  };

  const label = T('\u5de5\u4f5c\u53f0', 'Workbench');
  return <>
    <PluginSlot api={api} name="header">
      <button type="button" className={'gah-icon-btn gah-sb-toggle' + (open ? ' on' : '')} aria-pressed={open} aria-label={label}
        title={T('\u6587\u4ef6\u4e0e Git \u5de5\u4f5c\u53f0', 'Files & Git workbench')} onClick={toggleOpen}><Icon name={open ? 'folder-open' : 'folder'} /></button>
    </PluginSlot>
    {open ? <PluginSlot api={api} name="right">
      <aside className="gah-sb" style={{ width }} aria-label={label}>
        <div className="gah-sb-resize" role="separator" aria-orientation="vertical" onPointerDown={drag} />
        <div className="gah-sb-head">
          <div className="gah-sb-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'on' : ''} onClick={() => selectTab('files')}>{T('\u6587\u4ef6', 'Files')}</button>
            <button type="button" role="tab" aria-selected={tab === 'git'} className={tab === 'git' ? 'on' : ''} onClick={() => selectTab('git')}>{T('\u53d8\u66f4', 'Changes')}</button>
          </div>
          <span className="spacer" />
          <button type="button" className="gah-icon-btn" aria-label={T('\u5237\u65b0', 'Refresh')} title={T('\u5237\u65b0', 'Refresh')} onClick={() => setTick(t => t + 1)}><Icon name="refresh" /></button>
          <button type="button" className="gah-icon-btn" aria-label={T('\u5173\u95ed\u5de5\u4f5c\u53f0', 'Close workbench')} title={T('\u5173\u95ed\u5de5\u4f5c\u53f0', 'Close workbench')} onClick={toggleOpen}><Icon name="x" /></button>
        </div>
        <div className="gah-sb-roots" role="group" aria-label={T('\u6d4f\u89c8\u76ee\u5f55', 'Browsing directory')}>
          <button type="button" aria-pressed={root.root === 'auto'} onClick={() => selectRoot('auto')}
            title={T('\u672a\u8bbe\u7f6e\u5de5\u4f5c\u76ee\u5f55\u65f6\u4f7f\u7528\u9879\u76ee\u76ee\u5f55', 'Use the project directory when no workspace is set')}>{T('\u81ea\u52a8', 'Auto')}</button>
          <button type="button" aria-pressed={root.root === 'workspace'} onClick={() => selectRoot('workspace')}>{T('\u5de5\u4f5c\u76ee\u5f55', 'Workspace')}</button>
          <button type="button" aria-pressed={root.root === 'project'} disabled={!projectId} title={project?.name}
            onClick={() => selectRoot('project', projectId)}>{T('\u9879\u76ee\u76ee\u5f55', 'Project directory')}</button>
        </div>
        <div className={'gah-sb-body' + (activeView ? ' viewing' : '')}>
          {tab === 'files'
            ? <Files key={rootKey} api={api} root={root} tick={tick} active={activeView?.kind === 'file' ? activeView.path : ''} onOpen={path => openView('file', path)} />
            : <Changes key={rootKey} api={api} root={root} tick={tick} active={activeView?.kind === 'diff' ? activeView.path : ''} onOpen={path => openView('diff', path)} />}
          {activeView?.kind === 'file' ? <FileView key={rootKey + '\n' + activeView.path} api={api} root={root} path={activeView.path} tick={tick} leaveGuard={leaveGuard} onClose={() => setView(null)} /> : null}
          {activeView?.kind === 'diff' ? <DiffView key={rootKey + '\n' + activeView.path} api={api} root={root} path={activeView.path} tick={tick} onClose={() => setView(null)} /> : null}
        </div>
      </aside>
    </PluginSlot> : null}
  </>;
}

defineReact('web-sidebar', Sidebar);
