import { useEffect, useRef, useState } from 'react';
import { request } from '../api';
import { T } from '../i18n';
import { host, useHost } from '../store';
import type { AgentPreset, HostState } from '../types';

// Agent preset ("mode") chooser shown above the composer of an empty chat.
// It writes the per-session preset through /api/preset; no preset means the standard agent.
const label = (item: AgentPreset | null) => item ? T(item.name_zh || item.name, item.name) : T('\u6807\u51c6\u6a21\u5f0f', 'Standard');
const describe = (item: AgentPreset | null) => item
  ? T(item.description_zh || item.description || '', item.description || '')
  : T('\u5b8c\u6574\u7684 GenericAgent\uff0c\u4e0d\u52a0\u9650\u5236', 'Full GenericAgent, no restrictions');

const ModeIcon = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.5 13.6 4.75v6.5L8 14.5 2.4 11.25v-6.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><circle cx="8" cy="8" r="2" fill="currentColor" /></svg>;

// Read-only mode label shown next to the session title; the mode is fixed once a conversation starts.
export function ModeBadge() {
  const { state } = useHost();
  const presets = state.presets;
  if (!presets || !presets.items.length) return null;
  const active = presets.items.find(item => item.id === presets.current) ?? null;
  return <span className="gah-mode-badge" title={describe(active)}><ModeIcon /><span>{label(active)}</span></span>;
}

export function ModePicker({ disabled }: { disabled: boolean }) {
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
    if ((item?.id ?? null) === (presets?.current ?? null)) return;
    setSaving(true);
    try { host.setState(await request<HostState>('/api/preset', { value: item?.id ?? '' })); }
    catch (error) { host.report(error); }
    finally { setSaving(false); }
  }
  return <div className="gah-mode" ref={root}>
    <button type="button" ref={trigger} className="gah-mode-trigger" disabled={locked} aria-haspopup="listbox" aria-expanded={open}
      title={describe(active)} onClick={() => setOpen(value => !value)}>
      <ModeIcon />
      <span>{label(active)}</span><span className="gah-mode-caret" aria-hidden="true">{'\u2304'}</span>
    </button>
    {open && <ul className="gah-mode-menu" role="listbox" aria-label={T('Agent \u6a21\u5f0f', 'Agent mode')}>
      {[null, ...presets.items].map(item => {
        const selected = (item?.id ?? null) === (presets.current ?? null);
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
