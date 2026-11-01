import { useEffect, useRef, useState } from 'react';
import { request } from '../api';
import { T } from '../i18n';
import { host, useHost } from '../store';
import type { AgentPreset, HostState } from '../types';

// Agent preset ("mode") chooser: in the chat header (every chat) and above the composer of an empty chat.
// The mode can change at any time between runs and applies from the next message. It writes the per-session preset through /api/preset; no preset means the standard agent.
const label = (item: AgentPreset | null) => item ? T(item.name_zh || item.name, item.name) : T('\u6807\u51c6\u6a21\u5f0f', 'Standard');
const describe = (item: AgentPreset | null) => item
  ? T(item.description_zh || item.description || '', item.description || '')
  : T('\u5b8c\u6574\u7684 GenericAgent\uff0c\u4e0d\u52a0\u9650\u5236', 'Full GenericAgent, no restrictions');

const ModeIcon = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.5 13.6 4.75v6.5L8 14.5 2.4 11.25v-6.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><circle cx="8" cy="8" r="2" fill="currentColor" /></svg>;

const MISSING_TIP = T('\u8be5\u6a21\u5f0f\u7684\u6587\u4ef6\u5df2\u5220\u9664\u6216\u65e0\u6548\uff0c\u8bf7\u6362\u4e00\u4e2a\u6a21\u5f0f', 'This mode\'s file was removed or is invalid; pick another mode');

// ``head``: compact variant next to the session title (Standard included, so every chat tells its mode); menu opens downward.
export function ModePicker({ disabled, head = false }: { disabled: boolean; head?: boolean }) {
  const { state } = useHost();
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const presets = state.presets;
  const active = presets?.items.find(item => item.id === presets.current) ?? null;
  const locked = disabled || saving;
  useEffect(() => { if (locked) setOpen(false); }, [locked]);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  if (!presets || !presets.items.length) return null;
  async function choose(item: AgentPreset | null) {
    setOpen(false); trigger.current?.focus();
    if ((item?.id ?? null) === (presets?.current ?? presets?.missing ?? null)) return;
    setSaving(true);
    try { host.setState(await request<HostState>('/api/preset', { value: item?.id ?? '' })); }
    catch (error) { host.report(error); }
    finally { setSaving(false); }
  }
  const tip = presets.missing ? MISSING_TIP : describe(active) + (disabled ? T('\uff08\u8fd0\u884c\u4e2d\u4e0d\u53ef\u5207\u6362\uff09', ' (cannot switch while running)') : '');
  return <div className={head ? 'gah-mode head' : 'gah-mode'} ref={root}>
    <button type="button" ref={trigger} className={presets.missing ? 'gah-mode-trigger missing' : 'gah-mode-trigger'} disabled={locked} aria-haspopup="listbox" aria-expanded={open}
      title={tip} onClick={() => setOpen(value => !value)}>
      <ModeIcon />
      <span>{presets.missing ? presets.missing + T('\uff08\u5df2\u5931\u6548\uff09', ' (unavailable)') : label(active)}</span><span className="gah-mode-caret" aria-hidden="true">{'\u2304'}</span>
    </button>
    {open && <ul className="gah-mode-menu" role="listbox" aria-label={T('Agent \u6a21\u5f0f', 'Agent mode')}>
      {[null, ...presets.items].map(item => {
        const selected = !presets.missing && (item?.id ?? null) === (presets.current ?? null);
        return <li key={item?.id ?? ''} role="option" aria-selected={selected}>
          <button type="button" onClick={() => void choose(item)}>
            <span className="gah-mode-name">{label(item)}{item?.builtin === false && <small>{T('\u81ea\u5b9a\u4e49', 'Custom')}</small>}</span>
            <span className="gah-mode-desc">{describe(item)}</span>
            {selected && <span className="gah-mode-check" aria-hidden="true">{'\u2713'}</span>}
          </button>
        </li>;
      })}
    </ul>}
  </div>;
}
