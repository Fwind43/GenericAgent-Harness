import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PluginAPI } from '../sdk';
import type { HostState, RuntimeModel } from '../types';
import { useHost } from '../store';
import { T } from '../i18n';
import { PluginSlot, useOperation } from './shared';
import { matches } from './model-helpers';

const providerId = (model: RuntimeModel) => model.provider_id || model.provider || '__standalone';
export function ModelPicker({ api }: { api: PluginAPI }) {
  const { state } = useHost(), { busy, run } = useOperation(api);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [provider, setProvider] = useState('');
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const catalog = state.models, effort = state.effort;
  const current = catalog?.items.find(item => item.id === catalog.current);
  const groups = new Map<string, { name: string; count: number }>();
  for (const item of catalog?.items || []) {
    const id = providerId(item), group = groups.get(id) || { name: item.provider || T('\u72ec\u7acb\u914d\u7f6e', 'Standalone'), count: 0 };
    group.count++; groups.set(id, group);
  }
  const filter = groups.has(provider) ? provider : '';
  const items = catalog?.items.filter(item => (!filter || filter === providerId(item)) && matches(query, item.name, item.model, item.provider)) || [];
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus(); };
  useEffect(() => { if (busy || !catalog) setOpen(false); }, [busy, catalog]);
  useLayoutEffect(() => {
    if (!open || !popup.current) return;
    const node = popup.current;
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const w = node.offsetWidth, h = node.offsetHeight;
      node.style.left = Math.max(12, Math.min(rect.right - w, window.innerWidth - w - 12)) + 'px';
      node.style.top = Math.max(12, Math.min(rect.top - h - 8, window.innerHeight - h - 12)) + 'px';
    };
    node.showPopover(); position(); search.current?.focus();
    window.addEventListener('resize', position);
    return () => { window.removeEventListener('resize', position); if (node.matches(':popover-open')) node.hidePopover(); };
  }, [open]);
  const select = (path: string, body: unknown) => {
    close(true); void run(async () => api.setState(await api.host.post<HostState>(path, body)));
  };
  if (!catalog) return null;
  return <>
    <PluginSlot api={api} name="composer"><div className="gah-models">
      <button ref={trigger} type="button" className="gah-model-trigger" disabled={busy} aria-haspopup="dialog" aria-controls="gah-model-picker" aria-expanded={open} onClick={() => { setQuery(''); setProvider(''); setOpen(value => !value); }}>
        <span className="gah-model-name">{current?.name || current?.model || T('\u9009\u62e9\u6a21\u578b', 'Choose model')}</span>
        {effort && <span className="gah-model-effort">{effort.current || 'default'}</span>}<span className="gah-model-caret" aria-hidden="true">{'\u2303'}</span>
      </button>
    </div></PluginSlot>
    {open && createPortal(<div ref={popup} popover="auto" role="dialog" aria-label={T('\u6a21\u578b\u4e0e\u601d\u8003\u5f3a\u5ea6', 'Model and reasoning effort')} id="gah-model-picker" className="gah-model-popover" onToggle={event => { if (event.newState === 'closed') setOpen(false); }} onKeyDown={event => { if (event.key === 'Escape') close(true); }}>
      <div className="gah-picker-toolbar"><input ref={search} type="search" className="gah-picker-search" value={query} placeholder={T('\u641c\u7d22\u6a21\u578b\u6216\u670d\u52a1\u5546', 'Search models or providers')} aria-label={T('\u641c\u7d22\u6a21\u578b\u6216\u670d\u52a1\u5546', 'Search models or providers')} onChange={event => setQuery(event.target.value)} />
        <div className="gah-picker-filters"><select className="gah-picker-filter" value={filter} aria-label={T('\u7b5b\u9009\u670d\u52a1\u5546', 'Filter providers')} onChange={event => setProvider(event.target.value)}><option value="">{T('\u5168\u90e8\u670d\u52a1\u5546', 'All providers')}</option>{[...groups].map(([id, group]) => <option key={id} value={id}>{group.name} ({group.count})</option>)}</select><span className="gah-picker-count">{items.length} / {catalog.items.length}</span></div>
      </div>
      <div className="gah-picker-models">{items.map(item => <button type="button" className="gah-picker-option" key={item.id} data-model-id={item.id} aria-pressed={item.id === catalog.current} disabled={busy} onClick={() => select('/api/models/select', { id: item.id })}><span className="gah-picker-option-copy"><span>{item.name || item.model}</span><small>{[item.provider || T('\u72ec\u7acb\u914d\u7f6e', 'Standalone'), item.name && item.model !== item.name ? item.model : ''].filter(Boolean).join(' \u00b7 ')}</small></span><span className="gah-picker-check" aria-hidden="true">{item.id === catalog.current ? '\u2713' : ''}</span></button>)}{!items.length && <p className="gah-picker-empty">{T('\u6ca1\u6709\u5339\u914d\u7684\u6a21\u578b', 'No matching models')}</p>}</div>
      {effort && <div className="gah-picker-effort"><div className="gah-picker-label">{T('\u63a8\u7406\u5f3a\u5ea6', 'Reasoning effort')}<small>{T('\u4ec5\u5f53\u524d\u5bf9\u8bdd', 'This chat only')}</small></div><div className="gah-effort-options" role="group" aria-label={T('\u63a8\u7406\u5f3a\u5ea6', 'Reasoning effort')}>{['', ...effort.options].map(option => <button key={option} type="button" aria-pressed={option === (effort.current || '')} disabled={busy} onClick={() => select('/api/effort', { value: option })}>{option || 'default'}</button>)}</div></div>}
    </div>, document.body)}
  </>;
}
