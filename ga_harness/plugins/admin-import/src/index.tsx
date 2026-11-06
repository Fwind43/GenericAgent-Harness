import { useEffect, useRef, useState } from 'react';
import { type PluginAPI, useHost, T, SettingsPanel, useOperation, defineReact } from '@gah/sdk';

// Import GA Admin chats as harness sessions. main.py only reads the Admin folder.
type Chat = { id: string; title: string; updated: number; messages: number; imported: boolean; project?: string };
type Scan = { dir: string; chats: Chat[]; skipped: number };
type Result = { imported: string[]; existing: string[]; failed: { id: string; error: string }[] };
type Line = { zh: string; en: string };
type Job<R> = { status: 'running' | 'done' | 'error'; log: Line[]; next: number; result: R | null; error: string | null };

const when = (t: number) => (t ? new Date(t * 1000).toLocaleString() : '');

export function ImportPanel({ api }: { api: PluginAPI }) {
  const { changing } = useHost();
  const { working, run } = useOperation(api, true);
  const [path, setPath] = useState('');
  const [scan, setScan] = useState<Scan | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [log, setLog] = useState<Line[]>([]);
  const logRef = useRef<HTMLPreElement>(null);
  const busy = working || changing;

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  // main.py runs scan/import in a background job; poll its log until it finishes.
  const follow = async <R,>(kind: 'scan' | 'import', body: unknown): Promise<R> => {
    const { job } = await api.post<{ job: string }>(kind, body);
    for (let since = 0; ;) {
      await new Promise(done => setTimeout(done, 300));
      const state = await api.get<Job<R>>(`job?id=${encodeURIComponent(job)}&since=${since}`);
      since = state.next;
      if (state.log.length) setLog(prev => [...prev, ...state.log]);
      if (state.status === 'error') throw new Error(state.error || 'failed');
      if (state.status === 'done') return state.result as R;
    }
  };

  const load = (dir = path) => run(async () => {
    setError(''); setResult(null); setLog([]);
    const data = await follow<Scan>('scan', { path: dir.trim() });
    setScan(data); setPicked(new Set());
  }, setError, true);

  const start = () => run(async () => {
    if (!scan) return;
    setError(''); setLog([]);
    const res = await follow<Result>('import', { path: scan.dir, ids: [...picked] });
    setResult(res);
    // Mark chats now in harness locally instead of rescanning the whole folder;
    // failed ones stay picked so they can be retried.
    const done = new Set([...res.imported, ...res.existing]);
    setScan(prev => prev && { ...prev, chats: prev.chats.map(c => done.has(c.id) ? { ...c, imported: true } : c) });
    setPicked(prev => new Set([...prev].filter(id => !done.has(id))));
  }, setError, true);

  const fresh = scan?.chats.filter(c => !c.imported) || [];
  const all = fresh.length > 0 && fresh.every(c => picked.has(c.id));
  const toggle = (id: string) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setPicked(all ? new Set() : new Set(fresh.map(c => c.id)));

  return <SettingsPanel api={api} label={T('导入 Admin 聊天', 'Import Admin chats')} icon="folder-open" order={60} className="ai-dialog">
    <div className="dialog-head"><div>
      <h2>{T('导入 GA Admin 聊天记录', 'Import GA Admin chats')}</h2>
      <p>{T('填写 GA Admin 的安装/数据目录或其中的 chat_sessions 目录。只读取 Admin 文件；导入后的会话可以接着聊，附件只保留文字说明。',
        'Enter the GA Admin install/data folder or its chat_sessions folder. Admin files are only read; imported chats can be continued, and attachments are kept as text notes only.')}</p>
    </div></div>
    <div className="ai-body">
      <form className="ai-path" onSubmit={e => { e.preventDefault(); void load(); }}>
        <input className="ai-input" value={path} onChange={e => setPath(e.target.value)} placeholder={T('例如 D:\\ga-admin', 'e.g. D:\\ga-admin')} disabled={busy} />
        <button type="submit" className="btn" disabled={busy || !path.trim()}>{T('扫描', 'Scan')}</button>
      </form>
      {error && <p className="ai-error">{error}</p>}
      {log.length > 0 && <pre ref={logRef} className="ai-log" aria-live="polite">
        {log.map(line => T(line.zh, line.en)).join('\n')}</pre>}
      {scan && <>
        <div className="ai-row ai-muted">
          <span>{T(`${scan.dir}：${scan.chats.length} 个聊天`, `${scan.dir}: ${scan.chats.length} chats`)}
            {scan.skipped > 0 && T(`，${scan.skipped} 个文件无法读取已跳过`, `, ${scan.skipped} unreadable skipped`)}</span>
        </div>
        {scan.chats.length > 0 && <label className="ai-check">
          <input type="checkbox" checked={all} disabled={busy || !fresh.length} onChange={toggleAll} />
          {T('全选未导入', 'Select all not imported')}</label>}
        <div className="ai-list">
          {scan.chats.map(c => <label key={c.id} className={`ai-item${c.imported ? ' done' : ''}`}>
            <input type="checkbox" checked={c.imported || picked.has(c.id)} disabled={busy || c.imported} onChange={() => toggle(c.id)} />
            <span className="ai-title" title={c.title}>{c.title || c.id}</span>
            {c.project && <small className="ai-project" title={T('Admin 项目', 'Admin project')}>{c.project}</small>}
            <small className="ai-muted">{c.imported ? T('已导入', 'Imported') : `${c.messages} · ${when(c.updated)}`}</small>
          </label>)}
        </div>
        <div className="ai-row">
          {result && <span className="ai-muted">{T(`已导入 ${result.imported.length}，已存在 ${result.existing.length}，失败 ${result.failed.length}`,
            `Imported ${result.imported.length}, existing ${result.existing.length}, failed ${result.failed.length}`)}</span>}
          <span className="ai-spacer" />
          <button type="button" className="btn primary" disabled={busy || !picked.size} onClick={() => void start()}>
            {T(`导入所选（${picked.size}）`, `Import selected (${picked.size})`)}</button>
        </div>
        {result?.failed.map(f => <p key={f.id} className="ai-error">{f.id}: {f.error}</p>)}
      </>}
    </div>
  </SettingsPanel>;
}

defineReact('admin-import', ImportPanel);
