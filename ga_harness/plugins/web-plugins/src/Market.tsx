import { useEffect, useRef, useState } from 'react';
import { type PluginAPI, type PluginInfo, SettingsPanel, T, confirmDialog, matches } from '@gah/sdk';
import type { ImportResult } from './ImportPlugin';
import { categoryOf, descriptionOf } from './helpers';

type MarketItem = {
  full_name: string; name: string; owner: string; description: string; url: string; clone_url: string;
  stars: number; updated_at: string; default_branch: string; license: string; fork: boolean;
  plugin_name?: string; version?: string; category?: string; description_zh?: string;
  requires?: string[]; provides?: string[]; packages?: string[]; readme?: string;
};
type MarketList = { topic: string; items: MarketItem[]; fetched_at: number; cached: boolean };

const cleanVer = (v?: string) => (v || '').trim().replace(/^v/i, '');

function hasNewerVersion(localVer?: string, remoteVer?: string): boolean {
  const a = cleanVer(localVer), b = cleanVer(remoteVer);
  if (!b) return false;
  if (!a) return true;
  if (a === b) return false;
  const pa = a.split('.').map(s => parseInt(s, 10)), pb = b.split('.').map(s => parseInt(s, 10));
  if (pa.every(n => !Number.isNaN(n)) && pb.every(n => !Number.isNaN(n))) {
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0, nb = pb[i] || 0;
      if (nb !== na) return nb > na;
    }
    return false;
  }
  return a !== b;
}

async function request<R>(path: string, init?: RequestInit): Promise<R> {
  const response = await fetch(path, init);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data && typeof data === 'object' && 'error' in data ? String(data.error) : `HTTP ${response.status}`);
  if (!data || typeof data !== 'object') throw new Error('Invalid JSON response');
  return data as R;
}

// Repositories follow the gah-plugin-<name> convention; prefer plugin.toml's name when available.
const guessName = (item: MarketItem) => item.plugin_name || item.name.replace(/^gah-plugin-/, '');

function MarketReadme({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (window.GAHOutput?.setMarkdown) window.GAHOutput.setMarkdown(node, text);
    else node.textContent = text;
  }, [text]);
  return <div ref={ref} className="plugin-market-readme md" />;
}

// Plugin market: standalone Settings tab listing public GitHub repositories tagged with the plugin topic.
export function Market({ api, disabled, catalog, ensureCatalog, run, onDone }: {
  api: PluginAPI;
  disabled: boolean;
  catalog: PluginInfo[];
  ensureCatalog: () => void;
  run: (task: () => Promise<void>, onError: (message: string) => void) => Promise<unknown> | void;
  onDone: (result: ImportResult) => void;
}) {
  const [list, setList] = useState<MarketList | null>(null);
  const [loading, setLoading] = useState(false), [failure, setFailure] = useState(''), [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const load = async (refresh: boolean) => {
    setLoading(true); setFailure('');
    try { setList(await request<MarketList>('/api/plugins/market' + (refresh ? '?refresh=1' : ''))); }
    catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };
  const open = () => {
    ensureCatalog();
    if (!list && !loading) void load(false);
  };
  const install = async (item: MarketItem, replace = false) => {
    if (disabled) return;
    const ok = await confirmDialog({
      title: (replace ? T('\u66f4\u65b0\u63d2\u4ef6', 'Update plugin') : T('\u5b89\u88c5\u63d2\u4ef6', 'Install plugin')) + ' ' + item.full_name,
      message: replace
        ? T('\u5c06\u4ece GitHub \u62c9\u53d6\u6700\u65b0\u4ee3\u7801\u8986\u76d6\u5f53\u524d\u63d2\u4ef6\uff08\u82e5\u542b\u524d\u7aef\u6e90\u7801\u5c06\u81ea\u52a8\u6253\u5305\uff09\uff1b\u5df2\u542f\u7528\u7684\u70ed\u63d2\u62d4\u63d2\u4ef6\u4f1a\u7acb\u5373\u70ed\u91cd\u8f7d\u751f\u6548\u3002', 'Pull the latest code from GitHub and replace the installed plugin (frontend sources are built automatically); active hot-pluggable plugins hot-reload immediately.')
        : T('\u5e02\u573a\u6761\u76ee\u6765\u81ea GitHub \u4e0a\u7684\u7b2c\u4e09\u65b9\u4ed3\u5e93\uff0c\u672a\u7ecf\u5ba1\u6838\uff1b\u63d2\u4ef6\u4ee3\u7801\u4ee5\u5f53\u524d\u7528\u6237\u6743\u9650\u8fd0\u884c\u3002\u4ec5\u5b89\u88c5\u4f60\u4fe1\u4efb\u7684\u6765\u6e90\u3002\u5b89\u88c5\u540e\u9ed8\u8ba4\u672a\u542f\u7528\u3002', 'Market entries are unreviewed third-party GitHub repositories; plugin code runs with your user permissions. Only install sources you trust. Installed plugins start disabled.'),
    });
    if (!ok) return;
    setFailure('');
    void run(async () => {
      const result = await request<ImportResult>('/api/plugins/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: item.clone_url, replace }) });
      if (!result.imported) throw new Error('Invalid JSON response');
      onDone(result);
    }, setFailure);
  };
  const shown = (list?.items || []).filter(item => matches(query, item.full_name, item.plugin_name, item.version, item.description, item.description_zh, item.category, item.readme));
  return <SettingsPanel api={api} label={T('\u63d2\u4ef6\u5e02\u573a', 'Plugin market')} icon="download" order={31} className="gah-plugin-market-dialog" onOpen={open}>
    <div className="dialog-head"><h2>{T('\u63d2\u4ef6\u5e02\u573a', 'Plugin market')}</h2></div>
    <div className="dialog-content">
      <p className="plugin-note plugin-profile">{T('\u6570\u636e\u6765\u81ea GitHub topic ', 'Listed from the GitHub topic ')}<code>{list?.topic || 'ga-harness-plugin'}</code>{T('\uff0c\u672a\u7ecf\u5ba1\u6838\u3002\u7ed9\u81ea\u5df1\u7684\u63d2\u4ef6\u4ed3\u5e93\u6253\u4e0a\u8be5 topic \u5373\u53ef\u51fa\u73b0\u5728\u8fd9\u91cc\uff1b\u5b89\u88c5\u540e\u8bf7\u5230\u201c\u63d2\u4ef6\u201d\u9875\u542f\u7528\u3002', ', unreviewed. Tag your plugin repository with this topic to list it here; enable installed plugins under Plugins.')}</p>
      <div className="plugin-toolbar">
        <input className="plugin-search" type="search" value={query} placeholder={T('\u641c\u7d22\u5e02\u573a\u63d2\u4ef6\u540d\u79f0\u6216\u8bf4\u660e', 'Search market plugin names or descriptions')} aria-label={T('\u641c\u7d22\u5e02\u573a\u63d2\u4ef6', 'Search market plugins')} onChange={event => setQuery(event.target.value)} />
        <button type="button" className="secondary" disabled={loading} onClick={() => void load(true)}>{T('\u5237\u65b0', 'Refresh')}</button>
      </div>
      {failure && <p className="gah-error" role="status">{failure}</p>}
      {loading && !list && <p className="plugin-empty">{T('\u52a0\u8f7d\u4e2d...', 'Loading...')}</p>}
      {list && !shown.length && <p className="plugin-empty">{list.items.length ? T('\u6ca1\u6709\u7b26\u5408\u6761\u4ef6\u7684\u63d2\u4ef6', 'No matching plugins') : T('\u5e02\u573a\u91cc\u8fd8\u6ca1\u6709\u63d2\u4ef6', 'No plugins in the market yet')}</p>}
      <ul className="plugin-market-list" aria-label={T('\u63d2\u4ef6\u5e02\u573a\u5217\u8868', 'Plugin market list')}>{shown.map(item => {
        const pluginId = guessName(item);
        const local = catalog.find(plugin => plugin.name === pluginId);
        const conflict = !!local && !local.hot;
        const have = !!local && !!local.hot;
        const localVer = cleanVer(local?.version);
        const remoteVer = cleanVer(item.version);
        const outdated = have && hasNewerVersion(localVer, remoteVer);
        const desc = descriptionOf(item);
        const isOpen = !!expanded[item.full_name];
        return <li key={item.full_name} className="plugin-market-item" data-expanded={isOpen || undefined}>
          <div className="plugin-market-top">
            <div className="plugin-market-main">
              <div className="plugin-market-head">
                <span className="plugin-market-title">{pluginId}</span>
                {remoteVer && <span className="plugin-version">{'v' + remoteVer}</span>}
                {item.category && <span className="plugin-badge">{categoryOf(item)[1]}</span>}
                {have && <span className="plugin-tag" data-tag={outdated ? 'pending' : 'override'}>{outdated ? (localVer ? T('\u5df2\u88c5 v', 'Installed v') + localVer + ' \u2192 v' + remoteVer : T('\u53ef\u66f4\u65b0 v', 'Update v') + remoteVer) : (localVer ? T('\u5df2\u5b89\u88c5 v', 'Installed v') + localVer : T('\u5df2\u5b89\u88c5', 'Installed'))}</span>}
                <a className="plugin-market-name" href={item.url} target="_blank" rel="noreferrer noopener">{item.full_name}</a>
              </div>
              <p className="plugin-market-desc">{desc || T('\u6682\u65e0\u8bf4\u660e', 'No description')}</p>
              <div className="plugin-market-foot">
                <span className="plugin-market-meta">{'\u2605 ' + item.stars}{item.license && item.license !== 'NOASSERTION' ? ' \u00b7 ' + item.license : ''}{item.updated_at ? ' \u00b7 ' + item.updated_at.slice(0, 10) : ''}{item.fork ? ' \u00b7 fork' : ''}</span>
                {!!(item.requires?.length || item.provides?.length || item.packages?.length) && <div className="plugin-market-caps">
                  {!!item.requires?.length && <span className="plugin-tag">{T('\u4f9d\u8d56: ', 'Requires: ') + item.requires.join(', ')}</span>}
                  {!!item.provides?.length && <span className="plugin-tag">{T('\u63d0\u4f9b: ', 'Provides: ') + item.provides.join(', ')}</span>}
                  {!!item.packages?.length && <span className="plugin-tag">{'pip: ' + item.packages.join(', ')}</span>}
                </div>}
              </div>
            </div>
            <div className="plugin-market-actions">
              {item.readme && <button type="button" className="secondary plugin-market-detail-btn" aria-expanded={isOpen} onClick={() => setExpanded(prev => ({ ...prev, [item.full_name]: !isOpen }))}>{isOpen ? T('\u6536\u8d77\u8bf4\u660e', 'Hide details') : T('\u8be6\u7ec6\u8bf4\u660e', 'Details')}</button>}
              <button type="button" className={have && !outdated ? 'secondary' : 'plugin-import-submit'} disabled={disabled || conflict} title={conflict ? T('\u4e0e\u5185\u7f6e\u53d7\u4fdd\u62a4\u63d2\u4ef6\u540c\u540d\uff0c\u4e0d\u53ef\u8986\u76d6', 'Conflicts with a protected builtin plugin') : have ? T('\u4ece GitHub \u62c9\u53d6\u6700\u65b0\u4ee3\u7801\u8986\u76d6\u5e76\u70ed\u91cd\u8f7d', 'Pull latest code from GitHub and hot-reload') : undefined} onClick={() => void install(item, have)}>{conflict ? T('\u5185\u7f6e\u540c\u540d', 'Builtin') : have ? (outdated ? T('\u66f4\u65b0 v', 'Update v') + remoteVer : (localVer && remoteVer ? T('\u91cd\u65b0\u5b89\u88c5', 'Reinstall') : T('\u66f4\u65b0', 'Update'))) : T('\u5b89\u88c5', 'Install')}</button>
            </div>
          </div>
          {item.readme && isOpen && <MarketReadme text={item.readme} />}
        </li>;
      })}</ul>
    </div>
  </SettingsPanel>;
}
