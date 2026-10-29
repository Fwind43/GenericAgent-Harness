import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type PluginAPI, type ModelConfig, type ModelResult, useHost, T, SettingsPanel, useOperation, matches, defineReact, confirmDialog } from '@gah/sdk';
import { ModelPicker } from './ModelPicker';
import { ModelForm, type SaveModel } from './ModelForm';
import { ProviderForm } from './ProviderForm';
import { MixinForm } from './MixinForm';
import type { FetchModels, RemoteModel } from './RemoteModels';
import { endpoint, sections as modelSections, readonlyText, sectionKey, providerNames } from './helpers';

type Edit = { kind: 'model' | 'provider' | 'mixin'; id?: string; serial: number };
export function Models({ api }: { api: PluginAPI }) {
  const { state, changing } = useHost(), { busy, working, run } = useOperation(api);
  const [config, setConfig] = useState<ModelConfig | null>(null), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [section, setSection] = useState('');
  const [edit, setEdit] = useState<Edit>({ kind: 'provider', serial: 0 }), [detail, setDetail] = useState(false);
  const draft = useRef(false), blocked = useRef(false), leaving = useRef(false), alive = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const onDirtyChange = useCallback((value: boolean) => { draft.current = value; }, []);
  useLayoutEffect(() => { blocked.current = working || changing; }, [working, changing]);
  useEffect(() => {
    alive.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (draft.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { alive.current = false; window.removeEventListener('beforeunload', beforeUnload); };
  }, []);
  useLayoutEffect(() => {
    if (detail && window.matchMedia('(max-width: 700px)').matches) heading.current?.focus();
  }, [detail, edit.serial]);
  const canLeave = useCallback(async () => {
    if (blocked.current || leaving.current) return false;
    if (!draft.current) return true;
    leaving.current = true;
    try {
      return await confirmDialog({
        title: T('\u653e\u5f03\u672a\u4fdd\u5b58\u7684\u66f4\u6539\uff1f', 'Discard unsaved changes?'),
        message: T('\u5f53\u524d\u8f93\u5165\u8fd8\u6ca1\u6709\u4fdd\u5b58\u3002', 'Your current edits have not been saved.'),
        confirm: T('\u653e\u5f03\u66f4\u6539', 'Discard changes'), cancel: T('\u7ee7\u7eed\u7f16\u8f91', 'Keep editing'), danger: true,
      });
    } finally { leaving.current = false; }
  }, []);
  const navigate = async (change: () => void) => { if (await canLeave() && alive.current) change(); };
  const groups = config ? modelSections(config) : [], group = groups.find(item => item.id === section);
  const entries = (group?.entries || config?.entries || []).filter(item => matches(query, item.key, item.values.name, item.values.model, item.values.apibase));
  const providers = (config?.providers || []).filter(item => matches(query, item.id, item.values.name, item.values.apibase));
  const mixins = (config?.mixins || []).filter(item => matches(query, item.key, ...item.members));
  const mixin = config?.mixins?.find(item => item.key === edit.id);
  const entry = config?.entries.find(item => item.key === edit.id), provider = config?.providers.find(item => item.id === edit.id);
  const select = (kind: Edit['kind'], id?: string, showDetail = true) => {
    draft.current = false; setError(''); setDetail(showDetail); setEdit(old => ({ kind, id, serial: old.serial + 1 }));
  };
  const choose = (kind: Edit['kind'], id?: string) => { void navigate(() => select(kind, id)); };
  const switchView = (kind: Edit['kind']) => {
    if (kind === edit.kind) return;
    void navigate(() => {
      setQuery(''); setSection('');
      select(kind, kind === 'model' ? config?.entries[0]?.key : kind === 'mixin' ? config?.mixins?.[0]?.key : config?.providers[0]?.id, false);
    });
  };
  const filter = (id: string) => { void navigate(() => {
    setSection(id);
    const items = groups.find(item => item.id === id)?.entries || config?.entries || [];
    select('model', items.find(item => matches(query, item.key, item.values.name, item.values.model, item.values.apibase))?.key, false);
  }); };
  const openProvider = (id: string) => { void navigate(() => {
    setQuery(''); setSection(''); select('provider', id || config?.providers[0]?.id);
  }); };
  const viewModels = () => { if (!provider) return; void navigate(() => {
    setQuery(''); setSection('provider:' + provider.id);
    select('model', config?.entries.find(item => item.provider === provider.id)?.key, false);
  }); };
  async function load() {
    setConfig(null); setError(''); setQuery(''); setSection(''); draft.current = false;
    await run(async () => {
      const next = await api.host.get<ModelConfig>('/api/models/config');
      setConfig(next); select('provider', next.providers[0]?.id, false);
    }, setError, true);
  }
  const change: SaveModel = (action, id, values) => {
    if (!config?.writable || busy) return;
    setError('');
    const { options, ...fields } = values || {};
    void run(async () => {
      const next = await api.host.post<ModelResult>('/api/models/config', { action, revision: config.revision, [action.startsWith('provider_') ? 'id' : 'key']: id,
        ...(values ? { values: fields } : {}), ...(options ? { options } : {}) });
      setConfig(next.config); api.setState(next.state); setQuery('');
      if (action.startsWith('provider_')) {
        setSection('');
        select('provider', action === 'provider_save' ? id : next.config.providers[0]?.id, action === 'provider_save');
      } else if (action.startsWith('mixin_')) {
        setSection('');
        select('mixin', action === 'mixin_save' ? id : next.config.mixins?.[0]?.key, action === 'mixin_save');
      } else {
        const saved = next.config.entries.find(item => item.key === id);
        const candidate = saved && section ? sectionKey(saved) : section;
        const nextSection = modelSections(next.config).some(item => item.id === candidate) ? candidate : '';
        setSection(nextSection);
        select('model', saved?.key || next.config.entries.find(item => !nextSection || sectionKey(item) === nextSection)?.key, !!saved);
      }
      api.notice(T('\u914d\u7f6e\u5df2\u4fdd\u5b58\u5e76\u751f\u6548', 'Configuration saved and applied'));
    }, setError);
  };
  const fetchModels: FetchModels = async source => (await api.host.post<{ models: RemoteModel[] }>('/api/models/remote', source)).models || [];
  const addModels = (provider: string, protocol: string, ids: string[]) => {
    if (!config?.writable || busy || !ids.length) return;
    setError('');
    void run(async () => {
      const stamp = Date.now();
      const items = ids.map((model, index) => ({ key: 'native_' + protocol + '_config_' + stamp + '_' + index, values: { name: model, model, provider } }));
      const next = await api.host.post<ModelResult>('/api/models/config', { action: 'save_many', revision: config.revision, items });
      setConfig(next.config); api.setState(next.state);
      select('provider', provider, true);
      api.notice(T('\u5df2\u6dfb\u52a0 ' + ids.length + ' \u4e2a\u6a21\u578b', 'Added ' + ids.length + ' models'));
    }, setError);
  };
  const ungrouped = config?.entries.filter(item => !item.provider).length ?? 0;
  const autoGroup = async () => { if (!config?.writable || busy || !ungrouped) return;
    if (!await confirmDialog({ title: T('\u6309\u5730\u5740\u548c\u5bc6\u94a5\u81ea\u52a8\u5f52\u7ec4\uff1f', 'Group models by URL and key?'), message: T('\u5730\u5740\u548c\u5bc6\u94a5\u5b8c\u5168\u76f8\u540c\u7684\u672a\u5f52\u7ec4\u6a21\u578b\u5c06\u5408\u5e76\u4e3a\u670d\u52a1\u5546\uff0c\u6a21\u578b\u5b9e\u9645\u8fde\u63a5\u4e0d\u53d8\u3002', 'Ungrouped models with an identical URL and key become providers. Model connections stay the same.'), confirm: T('\u5f52\u7ec4', 'Group') })) return;
    setError(''); void run(async () => {
    const next = await api.host.post<ModelResult>('/api/models/config', { action: 'provider_group', revision: config.revision });
    setConfig(next.config); api.setState(next.state); setQuery(''); setSection('');
    select('provider', next.config.providers[0]?.id, false);
    api.notice(T('\u5df2\u5f52\u7ec4\u4e3a ', 'Grouped into ') + next.config.providers.length + T(' \u4e2a\u670d\u52a1\u5546', ' providers'));
  }, setError); };
  const locked = busy || !config?.writable, browsing = working || changing;
  const names = config ? providerNames(config) : new Map<string, string>();
  const isModel = edit.kind === 'model', isMixin = edit.kind === 'mixin';
  const title = isModel ? entry?.values.name || entry?.values.model || entry?.key : isMixin ? mixin?.key : provider?.values.name || provider?.id;
  return <>
    <ModelPicker api={api} />
    {state.models && <SettingsPanel api={api} label={T('\u6a21\u578b', 'Models')} icon="cpu" order={10} className="gah-model-dialog" onOpen={load} onBeforeLeave={canLeave}>
      <div className={'dialog-content model-workspace' + (detail ? ' is-detail' : '')}>
        <div className="model-workspace-head">
          <div className="model-view-switch" role="group" aria-label={T('\u6a21\u578b\u4e0e\u670d\u52a1\u5546', 'Models and providers')}>
            <button type="button" aria-pressed={edit.kind === 'provider'} disabled={browsing} onClick={() => switchView('provider')}>{T('\u670d\u52a1\u5546', 'Providers')}<span>{config?.providers.length ?? 0}</span></button>
            <button type="button" aria-pressed={isModel} disabled={browsing} onClick={() => switchView('model')}>{T('\u6a21\u578b', 'Models')}<span>{config?.entries.length ?? 0}</span></button>
            <button type="button" aria-pressed={isMixin} disabled={browsing} onClick={() => switchView('mixin')}>{T('故障转移组', 'Failover groups')}<span>{config?.mixins?.length ?? 0}</span></button>
          </div>
          <button type="button" className="secondary model-refresh" disabled={browsing} onClick={() => { void navigate(() => { void load(); }); }}>{T('\u5237\u65b0', 'Refresh')}</button>
        </div>
        {error && <p className="model-error" role="alert">{error}</p>}
        {!config && <p className="model-empty" role="status">{working ? T('\u52a0\u8f7d\u4e2d...', 'Loading...') : T('\u52a0\u8f7d\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u5237\u65b0\u3002', 'Unable to load configuration. Try refreshing.')}</p>}
        {config && <>
          {!config.writable && <div className="model-readonly" role="status"><span>{readonlyText(config)}</span></div>}
          {state.running && <p className="model-help model-running">{T('\u4efb\u52a1\u8fd0\u884c\u4e2d\uff0c\u53ef\u67e5\u770b\u914d\u7f6e\uff0c\u7ed3\u675f\u540e\u53ef\u7f16\u8f91\u3002', 'A run is active. You can browse; editing is available when it finishes.')}</p>}
          <div className={'model-layout' + (detail ? ' is-detail' : '')}>
            <aside className="model-list-pane">
              <div className="model-browser-tools">
                <input className="model-search" type="search" value={query} disabled={browsing} placeholder={isModel ? T('搜索模型...', 'Search models...') : isMixin ? T('搜索故障转移组...', 'Search failover groups...') : T('搜索服务商...', 'Search providers...')} aria-label={T('搜索配置', 'Search configurations')} onChange={event => setQuery(event.target.value)} />
                {isModel && <select className="model-provider-filter" value={section} disabled={browsing} aria-label={T('\u6309\u670d\u52a1\u5546\u7b5b\u9009', 'Filter by provider')} onChange={event => filter(event.target.value)}><option value="">{T('\u5168\u90e8\u6a21\u578b', 'All models')}</option>{groups.map(item => <option key={item.id} value={item.id}>{item.title} ({item.entries.length})</option>)}</select>}
                {edit.kind === 'provider' && ungrouped > 0 && <button type="button" className="secondary model-group" disabled={locked} title={T('\u6309\u76f8\u540c\u5730\u5740+\u5bc6\u94a5\u5f52\u7ec4\u672a\u5f52\u5c5e\u6a21\u578b', 'Group unassigned models by identical URL + key')} onClick={() => { void autoGroup(); }}>{T('\u81ea\u52a8\u5f52\u7ec4', 'Auto-group')} ({ungrouped})</button>}
                <button type="button" className="model-add" disabled={locked} onClick={() => choose(edit.kind)}>{isModel ? T('+ 新增模型', '+ Add model') : isMixin ? T('+ 新增故障转移组', '+ Add failover group') : T('+ 新增服务商', '+ Add provider')}</button>
              </div>
              <div className="model-list" aria-label={isModel ? T('模型列表', 'Model list') : isMixin ? T('故障转移组列表', 'Failover group list') : T('服务商列表', 'Provider list')}>
                {isModel ? entries.map(item => <button key={item.key} type="button" className="model-list-item" disabled={browsing} aria-pressed={edit.id === item.key} onClick={() => { if (edit.id !== item.key || !detail) choose('model', item.key); }}><strong>{item.values.name || item.values.model || item.key}</strong>{item.values.name && item.values.model && item.values.name !== item.values.model && <small className="model-list-id">{item.values.model}</small>}<small>{groups.find(candidate => candidate.id === sectionKey(item))?.title}</small></button>)
                  : isMixin ? mixins.map(item => <button key={item.key} type="button" className="model-list-item" disabled={browsing} aria-pressed={edit.id === item.key} onClick={() => { if (edit.id !== item.key || !detail) choose('mixin', item.key); }}><strong>{item.key}</strong><small>{item.members.join(' → ')}</small><small>{item.members.length} {T('个成员', 'members')}{item.indexed ? T(' · 下标引用', ' · index references') : ''}</small></button>)
                  : providers.map(item => <button key={item.id} type="button" className="model-list-item" disabled={browsing} aria-pressed={edit.id === item.id} onClick={() => { if (edit.id !== item.id || !detail) choose('provider', item.id); }}><strong>{names.get(item.id)}</strong><small>{endpoint(item.values.apibase)}</small><small>{config.entries.filter(model => model.provider === item.id).length} {T('\u4e2a\u6a21\u578b', 'models')}</small></button>)}
                {!(isModel ? entries.length : isMixin ? mixins.length : providers.length) && <p className="model-empty">{query ? T('没有匹配项，试试其他关键词。', 'No matches. Try another search.') : isModel ? T('还没有模型，点击上方新增。', 'No models yet. Add one above.') : isMixin ? T('还没有故障转移组，添加首选和备选模型以自动切换。', 'No failover groups yet. Add primary and fallback models for automatic switching.') : T('还没有服务商。新增后可在多个模型间共用地址和密钥。', 'No providers yet. Add one to share a URL and key across models.')}</p>}
              </div>
              <details className="model-source"><summary>{T('\u914d\u7f6e\u6587\u4ef6', 'Config file')}{config.format ? ' \u00b7 ' + config.format : ''}</summary><p>{T('\u6a21\u578b\u548c\u670d\u52a1\u5546\u76f4\u63a5\u4fdd\u5b58\u5728 GA \u7684 mykey.py\uff0c\u4fdd\u5b58\u540e\u7acb\u5373\u751f\u6548\u3002', 'Models and providers are saved directly to GA mykey.py and apply immediately.')}</p><code>{config.source || T('\u5f53\u524d\u8fd0\u884c\u914d\u7f6e', 'Current runtime configuration')}</code></details>
            </aside>
            <section className="model-editor" aria-label={isModel ? T('模型编辑器', 'Model editor') : isMixin ? T('故障转移组编辑器', 'Failover group editor') : T('服务商编辑器', 'Provider editor')} aria-busy={working}>
              <div className="model-editor-head">
                <button type="button" className="secondary model-back" disabled={browsing} onClick={() => { void navigate(() => select(edit.kind, edit.id, false)); }}>{T('\u8fd4\u56de\u5217\u8868', 'Back to list')}</button>
                <div><span className="model-eyebrow">{isModel ? (entry ? T('编辑模型', 'Edit model') : T('新模型', 'New model')) : isMixin ? (mixin ? T('编辑故障转移组', 'Edit failover group') : T('新故障转移组', 'New failover group')) : (provider ? T('编辑服务商', 'Edit provider') : T('新服务商', 'New provider'))}</span><h3 ref={heading} tabIndex={-1}>{title || (isModel ? T('新增模型', 'Add model') : isMixin ? T('新增故障转移组', 'Add failover group') : T('新增服务商', 'Add provider'))}</h3></div>
              </div>
              {isModel ? <ModelForm key={edit.serial} entry={entry} config={config} initialProvider={group?.provider?.id || (!section ? config.providers[0]?.id : '')} disabled={locked} onSave={change} onDirtyChange={onDirtyChange} onReset={() => choose('model', edit.id)} onProvider={openProvider} fetchModels={fetchModels} />
                : isMixin ? <MixinForm key={edit.serial} entry={mixin} config={config} disabled={locked} onSave={change} onDirtyChange={onDirtyChange} onReset={() => choose('mixin', edit.id)} />
                : <ProviderForm key={edit.serial} entry={provider} used={provider ? config.entries.filter(item => item.provider === provider.id).length : 0} disabled={locked} onSave={change} onDirtyChange={onDirtyChange} onReset={() => choose('provider', edit.id)} onModels={viewModels}
                  existing={new Set(config.entries.filter(item => item.provider === provider?.id).map(item => item.values.model || ''))} fetchModels={fetchModels} onAddModels={addModels} />}
            </section>
          </div>
        </>}
      </div>
    </SettingsPanel>}
  </>;
}

defineReact('web-models', Models);
