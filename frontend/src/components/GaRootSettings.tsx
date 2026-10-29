import { useEffect, useLayoutEffect, useState } from 'react';
import { T } from '../i18n';
import { settings, useSettings } from '../settings';

// Built-in "GenericAgent" settings section (desktop shell only). Lets users who already
// have a GenericAgent checkout point the app at it instead of the bundled copy. The choice
// is saved to desktop.json (ga_root) by the main process and applies after a restart.
const ID = 'ga-root';

type Where = { path: string | null; source: string | null };
type GaRootInfo = {
  running: Where | null; next: Where; choice: 'auto' | 'custom' | 'bundled';
  bundledDir: string; bundledAvailable: boolean; locked: boolean; settingsFile: string;
  dataDir?: { path: string; source: 'program' | 'home' | 'env'; fallback?: string };
};
type Result = { info: GaRootInfo; canceled?: boolean; error?: string };
type GaRootApi = {
  info(): Promise<GaRootInfo>;
  choose(): Promise<Result>;
  set(mode: 'bundled' | 'auto'): Promise<Result>;
  restart(force?: boolean): Promise<{ busy?: boolean; ok?: boolean }>;
};
type DesktopApi = { gaRoot?: GaRootApi; openPath?: (p: string) => Promise<unknown> };

const desktop = (window as unknown as { gahDesktop?: DesktopApi }).gahDesktop;
const api = desktop?.gaRoot;

function sourceText(src: string | null) {
  if (!src) return T('未找到', 'Not found');
  if (src === 'bundled') return T('应用内置副本', 'Bundled with the app');
  if (src.includes('(args)')) return T('desktop.json 启动参数 --ga-root', 'desktop.json args (--ga-root)');
  if (src.endsWith('desktop.json')) return T('手动指定', 'Chosen by you');
  if (src.includes('GA_ROOT')) return T('环境变量 GA_ROOT', 'GA_ROOT environment variable');
  if (src.endsWith('config.toml')) return src;
  return src;
}

export function GaRootSettings() {
  const { open, active } = useSettings();
  const visible = open && active === ID;
  const [info, setInfo] = useState<GaRootInfo | null>(null);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => api ? settings.register({ id: ID, label: 'GenericAgent', icon: 'settings', order: -95 }) : undefined, []);
  useEffect(() => {
    if (!api || !visible) return;
    let alive = true;
    api.info().then(i => { if (alive) setInfo(i); }).catch(() => {});
    return () => { alive = false; };
  }, [visible]);

  if (!api) return null;
  const act = (p: Promise<Result>) => {
    setFailure(''); setBusy(true);
    p.then(r => { setInfo(r.info); if (r.error) setFailure(r.error); })
      .catch((e: Error) => setFailure(e?.message || String(e)))
      .finally(() => setBusy(false));
  };
  const restart = async () => {
    setFailure('');
    try {
      const r = await api.restart(false);
      if (r.busy && window.confirm(T('仍有任务在运行，重启会中断它们。确定重启？', 'Tasks are still running and will be stopped. Restart anyway?'))) await api.restart(true);
    } catch (e) { setFailure((e as Error)?.message || String(e)); }
  };

  const i = info;
  const pending = !!i && !!i.running && i.running.path !== i.next.path;

  return <section id={'gah-settings-panel-' + ID} role="tabpanel" aria-labelledby={'gah-settings-tab-' + ID}
    className="gah-settings-panel gah-update-settings" hidden={!visible}>
    {visible && <>
      <div className="dialog-head"><h2>GenericAgent</h2></div>
      <div className="dialog-content">
        {!i ? <div className="gah-update-status">{T('加载中…', 'Loading…')}</div> : <>
          <div className="gah-setting-row">
            <div className="gah-setting-text"><strong>{T('当前使用的目录', 'Folder in use')}</strong>
              <span className="gah-ga-path">{i.running?.path || T('（无）', '(none)')}</span>
              <span>{T('来源：', 'Source: ')}{sourceText(i.running?.source ?? null)}</span></div>
            {i.running?.path && desktop?.openPath && <button type="button" className="gah-update-btn"
              onClick={() => desktop.openPath!(i.running!.path!).catch(() => {})}>{T('打开', 'Open')}</button>}
          </div>

          {i.dataDir && <div className="gah-setting-row">
            <div className="gah-setting-text"><strong>{T('数据目录', 'Data folder')}</strong>
              <span className="gah-ga-path">{i.dataDir.path}</span>
              <span>{i.dataDir.source === 'program' ? T('程序目录下的 data（设置、插件、上传文件、聊天记录）', 'data next to the program (settings, plugins, uploads, chats)')
                : i.dataDir.source === 'env' ? T('由 GAH_HOME 指定', 'Set by GAH_HOME')
                : i.dataDir.fallback ? T(`程序目录不可写（${i.dataDir.fallback}），改用用户目录`, `The program folder is not writable (${i.dataDir.fallback}); using the user folder`)
                : T('用户目录', 'User folder')}</span>
              <span>{T('聊天记录按 GenericAgent 目录分开保存，切换目录后显示对应的记录', 'Chats are kept per GenericAgent folder; switching folders shows that folder\'s chats')}</span></div>
            {desktop?.openPath && <button type="button" className="gah-update-btn"
              onClick={() => desktop.openPath!(i.dataDir!.path).catch(() => {})}>{T('打开', 'Open')}</button>}
          </div>}

          {pending && <div className="gah-update-card phase-ready" aria-live="polite">
            <div className="gah-update-status"><span className="gah-update-dot" />
              <span className="gah-update-phase">{T('重启后将改用：', 'After restart: ')}{i.next.path || T('（无）', '(none)')}</span></div>
            <div className="gah-update-actions">
              <button type="button" className="gah-update-btn primary" onClick={restart}>{T('立即重启', 'Restart now')}</button>
            </div>
          </div>}

          {i.locked ? <div className="gah-setting-row"><div className="gah-setting-text">
            <strong>{T('已由启动参数固定', 'Fixed by a launch argument')}</strong>
            <span>{T('desktop.json 的 args 中设置了 --ga-root，请在该文件中修改：', '--ga-root is set in desktop.json args; edit it there: ')}{i.settingsFile}</span></div></div> : <>
            <div className="gah-setting-row">
              <div className="gah-setting-text"><strong>{T('使用已有的 GenericAgent', 'Use an existing GenericAgent')}</strong>
                <span>{T('选择包含 agentmain.py 的目录，例如你之前安装的 GA', 'Pick a folder containing agentmain.py, e.g. a GA you already use')}</span></div>
              <button type="button" className={'gah-update-btn' + (i.choice === 'custom' ? '' : ' primary')} disabled={busy}
                onClick={() => act(api.choose())}>{T('选择目录…', 'Choose folder…')}</button>
            </div>
            {i.bundledAvailable && <div className="gah-setting-row">
              <div className="gah-setting-text"><strong>{T('使用内置副本', 'Use the bundled copy')}</strong>
                <span>{i.bundledDir}</span></div>
              <button type="button" className="gah-update-btn" disabled={busy || i.choice === 'bundled'}
                onClick={() => act(api.set('bundled'))}>{i.choice === 'bundled' ? T('已选择', 'Selected') : T('使用', 'Use')}</button>
            </div>}
            {i.choice !== 'auto' && <div className="gah-setting-row">
              <div className="gah-setting-text"><strong>{T('自动检测', 'Detect automatically')}</strong>
                <span>{T('依次使用 GA_ROOT、数据目录中的 config.toml，最后是内置副本', 'Use GA_ROOT, then config.toml in the data folder, then the bundled copy')}</span></div>
              <button type="button" className="gah-update-btn" disabled={busy}
                onClick={() => act(api.set('auto'))}>{T('恢复默认', 'Reset')}</button>
            </div>}
          </>}
          {failure && <div className="gah-update-error">{failure}</div>}
        </>}
      </div>
    </>}
  </section>;
}
