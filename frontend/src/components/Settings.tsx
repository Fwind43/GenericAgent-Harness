import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { T } from '../i18n';
import { Icon } from '../plugin-kit';
import { settings, useSettings } from '../settings';
import { useHost } from '../store';

export function Settings({ children }: { children: ReactNode }) {
  const { open, active, sections } = useSettings();
  const { changing } = useHost();
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    else if (!open && dialog?.open) dialog.close();
  }, [open]);
  useLayoutEffect(() => () => { ref.current?.close(); }, []);
  return <>
    {sections.length > 0 && <button type="button" className="side-item" id="settingsBtn" disabled={changing} aria-haspopup="dialog" aria-controls="gah-settings" onClick={settings.show}>
      <Icon name="settings" />{T('\u8bbe\u7f6e', 'Settings')}
    </button>}
    {createPortal(<dialog ref={ref} id="gah-settings" className="gah-dialog gah-settings-dialog" aria-labelledby="gah-settings-title" onCancel={event => {
      event.preventDefault(); if (!changing) settings.close();
    }} onClose={settings.close}>
      <nav className="gah-settings-nav">
      <div className="gah-settings-head"><h2 id="gah-settings-title">{T('\u8bbe\u7f6e', 'Settings')}</h2>
        <button type="button" className="gah-icon-btn gah-settings-close" disabled={changing} onClick={settings.close}
          aria-label={T('\u5173\u95ed', 'Close')} title={T('\u5173\u95ed (Esc)', 'Close (Esc)')}><Icon name="x" /></button>
      </div>
      <div className="gah-settings-tabs" aria-orientation="vertical" role="tablist" aria-label={T('\u8bbe\u7f6e\u5206\u7c7b', 'Settings sections')} onKeyDown={event => {
        if (changing || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = sections.findIndex(section => section.id === active);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1
          : (index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + sections.length) % sections.length;
        const section = sections[next];
        if (!section) return;
        settings.select(section.id);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>
        {sections.map(section => <button key={section.id} type="button" role="tab" className="gah-settings-tab" id={'gah-settings-tab-' + section.id}
          aria-selected={active === section.id} aria-controls={'gah-settings-panel-' + section.id} tabIndex={active === section.id ? 0 : -1}
          disabled={changing} onClick={() => settings.select(section.id)}><Icon name={section.icon} />{section.label}</button>)}
      </div>
      </nav>
      <div className="gah-settings-body">{children}</div>
    </dialog>, document.body)}
  </>;
}
