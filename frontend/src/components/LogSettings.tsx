import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { request } from '../api';
import { T } from '../i18n';
import { settings, useSettings } from '../settings';

// Built-in "Logs" settings section: browse the program log files (host.log, worker-*.log,
// faults.log, the desktop shell's backend.log) served read-only by GET /api/logs.
const ID = 'logs';
const TAIL_STEPS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];

type LogFile = { name: string; size: number; mtime: number };
type LogList = { dir: string; files: LogFile[] };
type LogTail = { name: string; path: string; size: number; mtime: number; truncated: boolean; text: string };
const desktop = (window as unknown as { gahDesktop?: { openPath?: (p: string) => Promise<unknown> } }).gahDesktop;

const fmtSize = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fmtTime = (s: number) => new Date(s * 1000).toLocaleString();

export function LogSettings() {
  const { open, active } = useSettings();
  const visible = open && active === ID;
  const [list, setList] = useState<LogList | null>(null);
  const [name, setName] = useState('');
  const [tail, setTail] = useState<LogTail | null>(null);
  const [step, setStep] = useState(0);
  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const boxRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);   // keep the view pinned to the end unless the user scrolled up

  useLayoutEffect(() => settings.register({ id: ID, label: T('\u65e5\u5fd7', 'Logs'), icon: 'pen', order: -80 }), []);

  const loadList = useCallback(async () => {
    const data = await request<LogList>('/api/logs');
    setList(data);
    setName(cur => cur && data.files.some(f => f.name === cur) ? cur
      : (data.files.find(f => f.name === 'host.log') || data.files[0])?.name || '');
    return data;
  }, []);

  const loadTail = useCallback(async (file: string, bytes: number) => {
    if (!file) { setTail(null); return; }
    setTail(await request<LogTail>(`/api/logs?name=${encodeURIComponent(file)}&bytes=${bytes}`));
  }, []);

  const refresh = useCallback(() => {
    setBusy(true); setError('');
    loadList().then(d => d.files.some(f => f.name === name) ? loadTail(name, TAIL_STEPS[step]) : undefined)
      .catch((e: Error) => setError(e?.message || String(e))).finally(() => setBusy(false));
  }, [loadList, loadTail, name, step]);

  useEffect(() => {
    if (!visible) return;
    setError('');
    loadList().catch((e: Error) => setError(e?.message || String(e)));
  }, [visible, loadList]);

  useEffect(() => {
    if (!visible || !name) return;
    stick.current = true;
    setBusy(true); setError('');
    loadTail(name, TAIL_STEPS[step]).catch((e: Error) => setError(e?.message || String(e))).finally(() => setBusy(false));
  }, [visible, name, step, loadTail]);

  useEffect(() => {
    if (!visible || !follow || !name) return;
    const timer = setInterval(() => {
      loadTail(name, TAIL_STEPS[step]).catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [visible, follow, name, step, loadTail]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && stick.current) box.scrollTop = box.scrollHeight;
  }, [tail, filter]);

  const onScroll = () => {
    const box = boxRef.current;
    if (box) stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  };

  const lines = tail ? tail.text.split('\n') : [];
  const needle = filter.trim().toLowerCase();
  const shown = needle ? lines.filter(l => l.toLowerCase().includes(needle)) : lines;
  const text = shown.join('\n');
  const copy = () => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined);
  const openDir = () => { if (list?.dir && desktop?.openPath) desktop.openPath(list.dir).catch((e: Error) => setError(e?.message || String(e))); };

  return <section id={'gah-settings-panel-' + ID} role="tabpanel" aria-labelledby={'gah-settings-tab-' + ID}
    className="gah-settings-panel gah-log-settings" hidden={!visible}>
    {visible && <>
      <div className="dialog-head"><h2>{T('\u65e5\u5fd7', 'Logs')}</h2></div>
      <div className="dialog-content">
        {list && <div className="gah-setting-row">
          <div className="gah-setting-text"><strong>{T('\u65e5\u5fd7\u76ee\u5f55', 'Log folder')}</strong>
            <span className="gah-ga-path">{list.dir}</span></div>
          {desktop?.openPath && <button type="button" className="gah-update-btn" onClick={openDir}>{T('\u6253\u5f00\u76ee\u5f55', 'Open folder')}</button>}
        </div>}
        <div className="gah-log-toolbar">
          <select className="gah-update-select" value={name} disabled={!list?.files.length}
            onChange={e => setName(e.target.value)} aria-label={T('\u65e5\u5fd7\u6587\u4ef6', 'Log file')}>
            {!list?.files.length && <option value="">{T('\u6682\u65e0\u65e5\u5fd7', 'No logs')}</option>}
            {list?.files.map(f => <option key={f.name} value={f.name}>{f.name} ({fmtSize(f.size)})</option>)}
          </select>
          <select className="gah-update-select" value={step} onChange={e => setStep(Number(e.target.value))}
            aria-label={T('\u8bfb\u53d6\u8303\u56f4', 'Range')}>
            {TAIL_STEPS.map((b, i) => <option key={b} value={i}>{T('\u6700\u540e ', 'Last ') + fmtSize(b)}</option>)}
          </select>
          <input className="gah-update-input" value={filter} onChange={e => setFilter(e.target.value)}
            placeholder={T('\u7b5b\u9009\u2026', 'Filter\u2026')} />
          <label className="gah-log-follow"><span className="gah-switch"><input type="checkbox" checked={follow}
            onChange={e => setFollow(e.target.checked)} /><span /></span>{T('\u81ea\u52a8\u5237\u65b0', 'Live')}</label>
          <button type="button" className="gah-update-btn" disabled={busy} onClick={refresh}>{T('\u5237\u65b0', 'Refresh')}</button>
          <button type="button" className="gah-update-btn" disabled={!text} onClick={copy}>{copied ? T('\u5df2\u590d\u5236', 'Copied') : T('\u590d\u5236', 'Copy')}</button>
        </div>
        {error && <div className="gah-update-error">{error}</div>}
        {tail && <div className="gah-update-hint">
          {`${fmtSize(tail.size)} \u00b7 ${fmtTime(tail.mtime)}`}
          {tail.truncated && ' \u00b7 ' + T('\u4ec5\u663e\u793a\u672b\u5c3e\u90e8\u5206', 'showing the end only')}
          {needle && ` \u00b7 ${shown.length}/${lines.length}`}
        </div>}
        <pre className="gah-log-view" ref={boxRef} onScroll={onScroll}>
          {text || <span className="gah-update-empty">{busy ? T('\u52a0\u8f7d\u4e2d\u2026', 'Loading\u2026') : T('(\u7a7a)', '(empty)')}</span>}
        </pre>
      </div>
    </>}
  </section>;
}
