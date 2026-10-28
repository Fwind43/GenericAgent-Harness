import { useLayoutEffect } from 'react';
import { language, save, T } from '../i18n';
import { settings, useSettings } from '../settings';

// Built-in "General" settings section (host-owned, listed first). Holds the UI
// language choice that used to live in the header; changing it reloads the page
// because every string is resolved once through T() at render/import time.
const ID = 'general';
const LANGS = [{ id: 'zh', label: '\u4e2d\u6587' }, { id: 'en', label: 'English' }] as const;

export function GeneralSettings() {
  const { open, active } = useSettings();
  const visible = open && active === ID;
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
      </div>
    </>}
  </section>;
}
