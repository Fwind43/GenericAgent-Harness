import { useRef, useState } from 'react';
import type { PluginAPI } from '../sdk';
import type { PluginCatalog } from '../types';
import { useHost } from '../store';
import { T } from '../i18n';
import { Icon, Modal, PluginSlot, useOperation } from './shared';
import { PluginDetails, type PluginChange } from './PluginDetails';
import { categories, categoryOf, descriptionOf, filters, inFilter, PluginTags, stateLabel } from './plugin-helpers';
import { matches } from './model-helpers';

export function PluginManager({ api }: { api: PluginAPI }) {
  const { state, changing } = useHost();
  const { busy, working, run } = useOperation(api);
  const [open, setOpen] = useState(false), [config, setConfig] = useState<PluginCatalog | null>(null);
  const [editing, setEditing] = useState<string | null>(null), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const cards = useRef<HTMLDivElement>(null), back = useRef<HTMLButtonElement>(null);
  const selected = config?.items.find(plugin => plugin.name === editing);
  const shown = (config?.items || []).filter(plugin => inFilter(plugin, filter) && matches(query, plugin.name, descriptionOf(plugin), categoryOf(plugin)[1], plugin.requires?.join(' '), plugin.provides?.join(' ')));
  const toGrid = () => {
    if (working) return;
    setEditing(null); setError('');
    requestAnimationFrame(() => { if (editing) cards.current?.querySelector<HTMLButtonElement>('[data-plugin="' + CSS.escape(editing) + '"]')?.focus(); });
  };
  const load = async () => {
    setOpen(true); setError('');
    await run(async () => { setConfig(await api.host.get<PluginCatalog>('/api/plugins')); }, setError, true);
  };
  const change: PluginChange = (action, enabled, values) => {
    if (!selected || selected.protected || busy || !config) return;
    if (action === 'reset' && !window.confirm(T('\u6e05\u9664\u7f51\u9875\u8986\u76d6\u5e76\u6062\u590d\u542f\u52a8\u914d\u7f6e\uff1f\u4e0b\u6b21\u542f\u52a8\u751f\u6548\u3002', 'Clear web overrides and restore startup settings? Applies on next start.'))) return;
    setError('');
    void run(async () => {
      setConfig(await api.host.post<PluginCatalog>('/api/plugins', { action, name: selected.name, revision: config.revision, ...(action === 'save' ? { enabled, config: values } : {}) }));
      api.notice(T('\u63d2\u4ef6\u914d\u7f6e\u5df2\u4fdd\u5b58\uff1b\u4e0b\u6b21\u542f\u52a8\u65f6\u751f\u6548', 'Plugin settings saved; they apply on next start'));
    }, setError);
  };
  return <>
    {state.plugins_enabled && <PluginSlot api={api} name="sidebar-foot"><div className="gah-plugins"><button type="button" className="side-item" disabled={working || changing} onClick={() => void load()}><Icon name="puzzle" />{T('\u63d2\u4ef6\u7ba1\u7406', 'Plugins')}</button>{config?.restart_required && <span className="plugin-note">{T('\u5df2\u4fdd\u5b58\uff0c\u4e0b\u6b21\u542f\u52a8\u751f\u6548', 'Saved; applies on next start')}</span>}</div></PluginSlot>}
    {open && <Modal className="gah-plugin-dialog" label={T('\u63d2\u4ef6\u7ba1\u7406', 'Plugins')} busy={working} onClose={() => selected ? toGrid() : setOpen(false)}>
      <div className="dialog-head"><h2>{T('\u63d2\u4ef6\u7ba1\u7406', 'Plugins')}</h2><button type="button" className="secondary" disabled={working} onClick={() => setOpen(false)}>{T('\u5173\u95ed', 'Close')}</button></div>
      <div className="dialog-content">
        <section className="plugin-catalog" hidden={!!selected}>
          {config && <p className="plugin-note">{T('\u542f\u52a8\u914d\u7f6e\uff1a', 'Startup profile: ') + config.profile}</p>}
          <div className="plugin-toolbar"><input className="plugin-search" type="search" value={query} placeholder={T('\u641c\u7d22\u63d2\u4ef6', 'Search plugins')} aria-label={T('\u641c\u7d22\u63d2\u4ef6', 'Search plugins')} onChange={event => setQuery(event.target.value)} /><button type="button" className="secondary" disabled={working || changing} onClick={() => void load()}>{T('\u5237\u65b0', 'Reload')}</button></div>
          <div className="plugin-filters" role="group" aria-label={T('\u63d2\u4ef6\u72b6\u6001', 'Plugin status')}>{filters.map(([key, label]) => <button key={key} type="button" className="plugin-filter" aria-pressed={filter === key} onClick={() => setFilter(key)}><span>{label}</span><span className="plugin-filter-count">{config?.items.filter(plugin => inFilter(plugin, key)).length || 0}</span></button>)}</div>
          {error && <p className="gah-error" role="alert">{error}</p>}
          <div className="plugin-groups" ref={cards} aria-label={T('\u63d2\u4ef6\u5217\u8868', 'Plugin list')}>{categories.map(([key, label]) => {
            const items = shown.filter(plugin => categoryOf(plugin)[0] === key);
            return items.length > 0 && <section key={key} className="plugin-category" data-category={key}><div className="plugin-category-head"><h3>{label}</h3><span>{items.length}</span></div><div className="plugin-grid">{items.map(plugin => <button key={plugin.name} type="button" className="plugin-card" data-plugin={plugin.name} data-state={plugin.state} disabled={working} onClick={() => { setEditing(plugin.name); setError(''); requestAnimationFrame(() => back.current?.focus()); }}>
              <span className="plugin-card-top"><span className="plugin-card-heading"><strong>{plugin.name}</strong><span className="plugin-card-status" data-state={plugin.state}>{stateLabel(plugin)}</span></span><span className="plugin-card-open" aria-hidden="true">{'\u203a'}</span></span>
              <span className="plugin-card-desc">{descriptionOf(plugin) || T('\u6682\u65e0\u8bf4\u660e', 'No description')}</span><span className="plugin-tags"><PluginTags plugin={plugin} /></span>
            </button>)}</div></section>;
          })}</div>
          {!shown.length && <p className="plugin-empty">{working ? T('\u52a0\u8f7d\u4e2d...', 'Loading...') : T('\u6ca1\u6709\u5339\u914d\u7684\u63d2\u4ef6', 'No matching plugins')}</p>}
        </section>
        {selected && <section className="plugin-detail"><button ref={back} type="button" className="plugin-back secondary" disabled={working} onClick={toGrid}>{T('\u8fd4\u56de\u63d2\u4ef6\u5217\u8868', 'Back to plugins')}</button><PluginDetails key={selected.name + ':' + config?.revision} plugin={selected} busy={working || changing} running={state.running} error={error} onChange={change} /></section>}
      </div>
    </Modal>}
  </>;
}
