import { useEffect, useLayoutEffect, useState } from 'react';
import { language, save, T } from '../i18n';
import { settings, useSettings } from '../settings';
import { useHost } from '../store';

// Built-in "General" settings section (host-owned, listed first). Holds the UI
// language choice that used to live in the header; changing it reloads the page
// because every string is resolved once through T() at render/import time.
const ID = 'general';
// Launch-at-login switch, desktop shell only (preload exposes window.gahDesktop.autostart).
type AutostartState = { supported: boolean; enabled: boolean };
type AutostartApi = { get(): Promise<AutostartState>; set(on: boolean): Promise<AutostartState> };
const autostartApi = (window as unknown as { gahDesktop?: { autostart?: AutostartApi } }).gahDesktop?.autostart;

const LANGS = [{ id: 'zh', label: '\u4e2d\u6587' }, { id: 'en', label: 'English' }] as const;

export function GeneralSettings() {
  const { open, active } = useSettings();
  const local = useHost().state.local;
  const [copied, setCopied] = useState(false);
  const copy = () => { if (!local) return;
    navigator.clipboard?.writeText(local.url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined); };
  const visible = open && active === ID;
  const [autostart, setAutostart] = useState<AutostartState | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartError, setAutostartError] = useState('');
  // Re-read on every open: the tray menu can toggle it while the panel is closed.
  useEffect(() => {
    if (!autostartApi || !visible) return;
    let alive = true;
    autostartApi.get().then(s => { if (alive) setAutostart(s); }).catch(() => {});
    return () => { alive = false; };
  }, [visible]);
  const toggleAutostart = (on: boolean) => {
    if (!autostartApi) return;
    setAutostartError(''); setAutostartBusy(true);
    autostartApi.set(on).then(s => {
      setAutostart(s);
      if (s.enabled !== on) setAutostartError(T('\u7cfb\u7edf\u672a\u5e94\u7528\u8be5\u8bbe\u7f6e', 'The system did not apply this setting'));
    })
      .catch((e: Error) => setAutostartError(e?.message || String(e)))
      .finally(() => setAutostartBusy(false));
  };
  useLayoutEffect(() => settings.register({ id: ID, label: T('\u901a\u7528', 'General'), icon: 'globe', order: -100 }), []);
  const choose = (lang: string) => { if (lang === language) return; save('gah-lang', lang); location.reload(); };
  return <section id={'gah-settings-panel-' + ID} role="tabpanel" aria-labelledby={'gah-settings-tab-' + ID}
    className="gah-settings-panel gah-general-settings" hidden={!visible}>
    {visible && <>
      <div className="dialog-head"><h2>{T('\u901a\u7528', 'General')}</h2></div>
      <div className="dialog-content">
        <div className="gah-setting-row">
          <div className="gah-setting-text"><strong>{T('\u8bed\u8a00', 'Language')}</strong>
            <span>{T('\u5207\u6362\u540e\u9875\u9762\u4f1a\u91cd\u65b0\u52a0\u8f7d', 'The page reloads after switching')}</span></div>
          <div className="gah-lang-options" role="radiogroup" aria-label={T('\u8bed\u8a00', 'Language')}>
            {LANGS.map(item => <button key={item.id} type="button" role="radio" aria-checked={language === item.id}
              data-lang={item.id} className={language === item.id ? 'active' : ''} onClick={() => choose(item.id)}>{item.label}</button>)}
          </div>
        </div>
        {autostart?.supported && <div className="gah-setting-row gah-autostart">
          <div className="gah-setting-text"><strong>{T('\u5f00\u673a\u81ea\u542f', 'Launch at login')}</strong>
            <span>{T('\u767b\u5f55\u7cfb\u7edf\u540e\u81ea\u52a8\u542f\u52a8\uff0c\u53ea\u5728\u6258\u76d8\u8fd0\u884c\u4e0d\u5f39\u7a97\u53e3', 'Start after you sign in, in the tray without opening a window')}</span>
            {autostartError && <span className="gah-update-error">{autostartError}</span>}</div>
          <label className="gah-switch"><input type="checkbox" aria-label={T('\u5f00\u673a\u81ea\u542f', 'Launch at login')}
            checked={autostart.enabled} disabled={autostartBusy}
            onChange={e => toggleAutostart(e.target.checked)} /><span /></label>
        </div>}
        {local && <div className="gah-setting-row gah-local-address">
          <div className="gah-setting-text"><strong>{T('\u672c\u5730\u5730\u5740', 'Local address')}</strong>
            <span className="gah-ga-path">{local.url}</span>
            <span>{T('\u76d1\u542c ', 'Listening on ') + local.host + ':' + local.port
              + (/^(127\.|::1$|localhost$)/.test(local.host) ? T('\uff0c\u4ec5\u672c\u673a\u53ef\u8bbf\u95ee\uff1b\u5916\u90e8\u8bbe\u5907\u8bf7\u7528\u8fdc\u7a0b\u8bbf\u95ee\u63d2\u4ef6', '; this machine only, use a remote-access plugin for other devices') : '')}</span></div>
          {window.isSecureContext && navigator.clipboard && <div className="gah-lang-options">
            <button type="button" onClick={copy}>{copied ? T('\u5df2\u590d\u5236', 'Copied') : T('\u590d\u5236', 'Copy')}</button></div>}
        </div>}
      </div>
    </>}
  </section>;
}
