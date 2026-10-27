import { useRef, useState } from 'react';
import { type PluginAPI, type PluginCatalog, useHost, T, SettingsPanel, useOperation, matches, confirmDialog, defineReact } from '@gah/sdk';
import { PluginDetails, type PluginChange } from './PluginDetails';
import { categories, categoryOf, descriptionOf, filters, inFilter, PluginTags, stateLabel } from './helpers';

export function PluginManager({ api }: { api: PluginAPI }) {
  const { state, changing } = useHost();
  const { busy, working, run } = useOperation(api);
  const [config, setConfig] = useState<PluginCatalog | null>(null);
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
    setError('');
    await run(async () => { setConfig(await api.host.get<PluginCatalog>('/api/plugins')); }, setError, true);
  };
  const change: PluginChange = async (action, enabled, values) => {
    if (!selected || selected.protected || busy || !config) return;
    if (action === 'reset' && !(await confirmDialog({ title: T('\u6062\u590d\u542f\u52a8\u914d\u7f6e', 'Restore startup settings'), danger: true, message: T('\u6e05\u9664\u7f51\u9875\u8986\u76d6\u5e76\u6062\u590d\u542f\u52a8\u914d\u7f6e\uff1f\u4e0b\u6b21\u542f\u52a8\u751f\u6548\u3002', 'Clear web overrides and restore startup settings? Applies on next start.') }))) return;
    setError('');
    void run(async () => {
      setConfig(await api.host.post<PluginCatalog>('/api/plugins', { action, name: selected.name, revision: config.revision, ...(action === 'save' ? { enabled, config: values } : {}) }));
      api.notice(T('\u63d2\u4ef6\u914d\u7f6e\u5df2\u4fdd\u5b58\uff1b\u4e0b\u6b21\u542f\u52a8\u65f6\u751f\u6548', 'Plugin settings saved; they apply on next start'));
    }, setError);
  };
  const install = () => {
    if (!selected?.missing_packages?.length || busy) return;
    setError('');
    void run(async () => {
      const result = await api.host.post<{ ok: boolean; output: string; catalog: PluginCatalog }>('/api/plugins', { action: 'install', name: selected.name });
      setConfig(result.catalog);
      if (result.ok) api.notice(T('\u4f9d\u8d56\u5df2\u5b89\u88c5\uff1b\u4e0b\u6b21\u542f\u52a8\u65f6\u751f\u6548', 'Packages installed; they apply on next start'));
      else setError(T('\u5b89\u88c5\u5931\u8d25\uff1a', 'Installation failed: ') + (result.output || '').slice(-800));
    }, setError);
  };
  return <>
    {state.plugins_enabled && <SettingsPanel api={api} label={T('\u63d2\u4ef6', 'Plugins')} icon="puzzle" order={30} className="gah-plugin-dialog" onOpen={load}>
      <div className="dialog-head"><h2>{T('\u63d2\u4ef6\u7ba1\u7406', 'Plugins')}</h2></div>
      <div className="dialog-content">
        {config?.restart_required && <p className="plugin-note" role="status">{T('\u5df2\u4fdd\u5b58\uff0c\u4e0b\u6b21\u542f\u52a8\u751f\u6548', 'Saved; applies on next start')}</p>}
        <section className="plugin-catalog" hidden={!!selected}>
          <p className="plugin-note plugin-profile" hidden={!config}>{config ? T('\u914d\u7f6e\u65b9\u6848\uff1a', 'Profile: ') + config.profile + T('\u3002\u66f4\u6539\u4ec5\u4fdd\u5b58\u5230\u672c\u5730\uff0c\u4e0b\u6b21\u542f\u52a8\u751f\u6548\uff0c\u4e0d\u4e2d\u65ad\u5f53\u524d\u63d2\u4ef6\u3002', '. Changes are saved locally and apply on next start without interrupting running plugins.') : ''}</p>
          <div className="plugin-toolbar"><input className="plugin-search" type="search" value={query} placeholder={T('\u641c\u7d22\u63d2\u4ef6\u540d\u79f0\u6216\u8bf4\u660e', 'Search plugin names or descriptions')} aria-label={T('\u641c\u7d22\u63d2\u4ef6', 'Search plugins')} disabled={working} onChange={event => setQuery(event.target.value)} /><button type="button" className="secondary" disabled={working || changing} onClick={() => void load()}>{T('\u5237\u65b0', 'Refresh')}</button></div>
          <div className="plugin-filters" role="tablist" aria-label={T('\u6309\u72b6\u6001\u7b5b\u9009', 'Filter by status')}>{filters.map(([key, label]) => <button key={key} type="button" role="tab" className="plugin-filter" data-filter={key} aria-selected={filter === key} onClick={() => setFilter(key)}>{label}<span className="plugin-count">{config?.items.filter(plugin => inFilter(plugin, key)).length || 0}</span></button>)}</div>
          {error && !selected && <p className="gah-error" role="status">{error}</p>}
          <div className="plugin-groups" ref={cards} aria-label={T('\u63d2\u4ef6\u5217\u8868', 'Plugin list')}>{categories.map(([key, label]) => {
            const items = shown.filter(plugin => categoryOf(plugin)[0] === key);
            return items.length > 0 && <section key={key} className="plugin-group" data-category={key}><h3 className="plugin-group-title">{label}<span className="plugin-count">{items.length}</span></h3><ul className="plugin-grid" aria-label={label}>{items.map(plugin => <li key={plugin.name}><button type="button" className="plugin-card" data-plugin={plugin.name} data-state={plugin.state} aria-label={plugin.name + T('\uff0c', ', ') + stateLabel(plugin)} disabled={working} onClick={() => { setEditing(plugin.name); setError(''); requestAnimationFrame(() => back.current?.focus()); }}>
              <span className="plugin-card-head"><span className="plugin-name" title={plugin.name}>{plugin.name}</span><span className="plugin-badge" data-state={plugin.state}>{stateLabel(plugin)}</span></span>
              <span className="plugin-card-desc">{descriptionOf(plugin) || T('\u6682\u65e0\u8bf4\u660e', 'No description')}</span>
              <span className="plugin-card-foot"><PluginTags plugin={plugin} /><span className="plugin-card-meta">{plugin.provides?.length ? T('\u63d0\u4f9b ', 'Provides ') + plugin.provides.length + T(' \u9879\u80fd\u529b', ' capabilities') : ''}</span></span>
            </button></li>)}</ul></section>;
          })}</div>
          {!shown.length && <p className="plugin-empty">{working ? T('\u52a0\u8f7d\u4e2d...', 'Loading...') : config?.items.length ? T('\u6ca1\u6709\u7b26\u5408\u6761\u4ef6\u7684\u63d2\u4ef6', 'No matching plugins') : T('\u6ca1\u6709\u53d1\u73b0\u53ef\u7ba1\u7406\u7684\u63d2\u4ef6', 'No manageable plugins found')}</p>}
        </section>
        {selected && <section className="plugin-detail"><button ref={back} type="button" className="secondary plugin-back" disabled={working} onClick={toGrid}>{T('\u2190 \u5168\u90e8\u63d2\u4ef6', '\u2190 All plugins')}</button><PluginDetails key={selected.name + ':' + config?.revision} plugin={selected} busy={working || changing} running={state.running} error={error} onChange={change} onInstall={install} /></section>}
      </div>
    </SettingsPanel>}
  </>;
}

defineReact('web-plugins', PluginManager);
