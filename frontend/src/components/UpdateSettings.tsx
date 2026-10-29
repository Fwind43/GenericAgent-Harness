import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { T } from '../i18n';
import { settings, useSettings } from '../settings';

// Built-in "Updates" settings section. Only exists inside the desktop shell, where the
// preload exposes window.gahDesktop.updates; the main-process Updater pushes its state
// (phase, download progress, log) so the user can follow a check/download/install.
const ID = 'updates';

type Preset = { label: string; value: string };
type LogLine = { t: number; level: string; msg: string };
type UpdateState = {
  shellVersion: string; codeVersion: string; codeSource: string; packaged: boolean;
  releasesPage: string; settingsFile: string; autoCheck: boolean; mirror: string; presets: Preset[];
  phase: string; kind: string | null; version: string | null; received: number; total: number;
  error: string | null; checkedAt: number | null; busy: boolean; log: LogLine[];
};
type UpdatesApi = {
  state(): Promise<UpdateState>;
  check(): Promise<unknown>;
  install(): Promise<unknown>;
  restart(): Promise<unknown>;
  configure(patch: Partial<Pick<UpdateState, 'autoCheck' | 'mirror'>>): Promise<unknown>;
  onState(fn: (s: UpdateState) => void): () => void;
  onOpen(fn: () => void): () => void;
};
type DesktopApi = { updates?: UpdatesApi; openExternal?: (url: string) => Promise<unknown> };

const desktop = (window as unknown as { gahDesktop?: DesktopApi }).gahDesktop;
const api = desktop?.updates;

const ACTIVE = new Set(['checking', 'downloading', 'verifying', 'installing']);
const mb = (n: number) => (n / 1048576).toFixed(1) + ' MB';
const clock = (t: number) => new Date(t).toLocaleTimeString();

function phaseText(s: UpdateState) {
  switch (s.phase) {
    case 'checking': return T('正在检查更新…', 'Checking for updates…');
    case 'latest': return T('已是最新版本', 'You are up to date');
    case 'available': return s.kind === 'manual'
      ? T(`发现新版本 ${s.version}，需要手动下载安装包`, `Version ${s.version} is available; download the installer manually`)
      : T(`发现新版本 ${s.version}`, `Version ${s.version} is available`);
    case 'downloading': return T('正在下载…', 'Downloading…');
    case 'verifying': return T('正在校验文件…', 'Verifying…');
    case 'installing': return T('正在安装…', 'Installing…');
    case 'ready': return T(`${s.version} 已就绪，重启后生效`, `${s.version} is ready; restart to apply`);
    case 'error': return T('更新失败：', 'Update failed: ') + (s.error || '');
    case 'source': return T('源码运行，不支持自动更新（请用 git pull）', 'Running from source; use git pull to update');
    default: return T('尚未检查', 'Not checked yet');
  }
}

export function UpdateSettings() {
  const { open, active } = useSettings();
  const visible = open && active === ID;
  const [state, setState] = useState<UpdateState | null>(null);
  const [failure, setFailure] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [mirrorError, setMirrorError] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => api ? settings.register({ id: ID, label: T('更新', 'Updates'), icon: 'settings', order: -90 }) : undefined, []);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    api.state().then(s => { if (alive) setState(s); }).catch(() => {});
    const offState = api.onState(s => setState(s));
    const offOpen = api.onOpen(() => { settings.show(); settings.select(ID); });
    return () => { alive = false; offState(); offOpen(); };
  }, []);
  useEffect(() => {
    if (state && !editing && !state.presets.some(p => p.value === state.mirror)) setDraft(state.mirror);
  }, [state?.mirror, editing]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state?.log.length, visible]);

  if (!api) return null;
  const run = (p: Promise<unknown>) => { setFailure(''); p.catch((e: Error) => setFailure(e?.message || String(e))); };
  const s = state;
  const working = !!s && (s.busy || ACTIVE.has(s.phase));
  const pct = s && s.total > 0 ? Math.min(100, Math.round(s.received / s.total * 100)) : null;
  const isPreset = !!s && s.presets.some(p => p.value === s.mirror);
  const custom = !!s && (editing || !isPreset);
  const saveMirror = () => {
    const v = draft.trim();
    if (!/^https?:\/\/[^\s/]+/i.test(v)) { setMirrorError(T('请输入以 http:// 或 https:// 开头的地址', 'Enter an address starting with http:// or https://')); return; }
    setMirrorError('');
    run(api.configure({ mirror: v }).then(() => api.state()).then(n => { setState(n); setEditing(false); }));
  };

  return <section id={'gah-settings-panel-' + ID} role="tabpanel" aria-labelledby={'gah-settings-tab-' + ID}
    className="gah-settings-panel gah-update-settings" hidden={!visible}>
    {visible && <>
      <div className="dialog-head"><h2>{T('更新', 'Updates')}</h2></div>
      <div className="dialog-content">
        {!s ? <div className="gah-update-status">{T('加载中…', 'Loading…')}</div> : <>
          <div className="gah-setting-row">
            <div className="gah-setting-text"><strong>{T('当前版本', 'Current version')}</strong>
              <span>{T('应用', 'App')} {s.codeVersion}{s.codeSource === 'update' ? T('（已在线更新）', ' (updated)') : ''} · {T('外壳', 'Shell')} {s.shellVersion}</span></div>
            <button type="button" className="gah-update-btn" disabled={working} onClick={() => run(api.check())}>
              {s.phase === 'checking' ? T('检查中…', 'Checking…') : T('检查更新', 'Check now')}</button>
          </div>

          <div className={'gah-update-card phase-' + s.phase} aria-live="polite">
            <div className="gah-update-status">
              <span className={'gah-update-dot' + (working ? ' busy' : '')} />
              <span className="gah-update-phase">{phaseText(s)}</span>
              {s.checkedAt && !working && <span className="gah-update-time">{T('上次检查', 'Last checked')} {clock(s.checkedAt)}</span>}
            </div>
            {(s.phase === 'downloading' || s.phase === 'verifying' || s.phase === 'installing') && <div className="gah-update-progress">
              <div className={'gah-update-bar' + (pct === null || s.phase !== 'downloading' ? ' indeterminate' : '')}
                role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
                <i style={pct !== null && s.phase === 'downloading' ? { width: pct + '%' } : undefined} /></div>
              {s.phase === 'downloading' && <span>{mb(s.received)}{s.total ? ' / ' + mb(s.total) : ''}{pct !== null ? ` · ${pct}%` : ''}</span>}
            </div>}
            <div className="gah-update-actions">
              {s.phase === 'available' && <button type="button" className="gah-update-btn primary" disabled={working} onClick={() => run(api.install())}>
                {s.kind === 'manual' ? T('打开下载页', 'Open download page') : s.kind === 'shell' ? T('下载安装包', 'Download installer') : T('下载并安装', 'Download and install')}</button>}
              {s.phase === 'ready' && <button type="button" className="gah-update-btn primary" onClick={() => run(api.restart())}>{T('立即重启', 'Restart now')}</button>}
              {s.phase === 'error' && <button type="button" className="gah-update-btn" onClick={() => run(api.check())}>{T('重试', 'Retry')}</button>}
              <button type="button" className="gah-update-link" onClick={() => desktop?.openExternal?.(s.releasesPage)}>{T('查看发布说明', 'Release notes')}</button>
            </div>
            {failure && <div className="gah-update-error">{failure}</div>}
          </div>

          <div className="gah-setting-row">
            <div className="gah-setting-text"><strong>{T('自动检查', 'Check automatically')}</strong>
              <span>{T('启动后与每 6 小时在后台检查一次', 'In the background at startup and every 6 hours')}</span></div>
            <label className="gah-switch"><input type="checkbox" checked={!!s.autoCheck}
              onChange={e => run(api.configure({ autoCheck: e.target.checked }).then(() => api.state()).then(setState))} /><span /></label>
          </div>
          <div className="gah-setting-row">
            <div className="gah-setting-text"><strong>{T('下载源', 'Download mirror')}</strong>
              <span>{T('GitHub 访问慢时可换镜像', 'Use a mirror if GitHub is slow')}</span></div>
            <select className="gah-update-select" value={custom ? '__custom' : s.mirror} disabled={working}
              onChange={e => {
                if (e.target.value === '__custom') { setDraft(isPreset ? '' : s.mirror); setEditing(true); return; }
                setEditing(false); setMirrorError('');
                run(api.configure({ mirror: e.target.value }).then(() => api.state()).then(setState));
              }}>
              {s.presets.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              <option value="__custom">{isPreset ? T('自定义…', 'Custom…') : T('自定义：', 'Custom: ') + s.mirror}</option>
            </select>
          </div>
          {custom && <div className="gah-setting-row gah-update-mirror">
            <div className="gah-update-mirror-edit">
              <input className="gah-update-input" type="url" spellCheck={false} disabled={working} value={draft}
                placeholder={T('https://mirror.example.com/ 或 https://mirror.example.com/{url}', 'https://mirror.example.com/ or https://mirror.example.com/{url}')}
                onChange={e => { setDraft(e.target.value); setMirrorError(''); }}
                onKeyDown={e => { if (e.key === 'Enter') saveMirror(); else if (e.key === 'Escape' && !isPreset) { setDraft(s.mirror); setMirrorError(''); } }} />
              <button type="button" className="gah-update-btn primary" disabled={working || draft.trim() === s.mirror} onClick={saveMirror}>{T('保存', 'Save')}</button>
              {isPreset && <button type="button" className="gah-update-btn" onClick={() => { setEditing(false); setMirrorError(''); }}>{T('取消', 'Cancel')}</button>}
            </div>
            <span className="gah-update-hint">{T('下载地址会拼在镜像地址后面；包含 {url} 时替换为原始 GitHub 地址。',
              'The GitHub URL is appended to the mirror; if it contains {url}, that placeholder is replaced instead.')}</span>
            {mirrorError && <div className="gah-update-error">{mirrorError}</div>}
          </div>}

          <div className="gah-update-log-head"><strong>{T('更新日志', 'Activity')}</strong><span>{s.log.length}</span></div>
          <div className="gah-update-log" ref={logRef}>
            {s.log.length ? s.log.map((l, i) => <div key={i} className={'gah-update-line ' + l.level}>
              <time>{clock(l.t)}</time><span>{l.msg}</span></div>) : <div className="gah-update-empty">{T('暂无记录', 'Nothing yet')}</div>}
          </div>
        </>}
      </div>
    </>}
  </section>;
}
