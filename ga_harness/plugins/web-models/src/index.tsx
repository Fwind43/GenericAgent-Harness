import { useState } from 'react';
import { type PluginAPI, type ModelConfig, type ModelResult, useHost, T, SettingsPanel, useOperation, matches, defineReact } from '@gah/sdk';
import { ModelPicker } from './ModelPicker';
import { ModelForm, type SaveModel } from './ModelForm';
import { ProviderForm } from './ProviderForm';
import { sections as modelSections, readonlyText, sectionKey } from './helpers';

type Edit = { kind: 'model' | 'provider'; id?: string; serial: number };
export function Models({ api }: { api: PluginAPI }) {
  const { state } = useHost(), { busy, working, run } = useOperation(api);
  const [config, setConfig] = useState<ModelConfig | null>(null), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [section, setSection] = useState('');
  const [edit, setEdit] = useState<Edit>({ kind: 'model', serial: 0 });
  const groups = config ? modelSections(config) : [], group = groups.find(item => item.id === section);
  const entries = (group?.entries || config?.entries || []).filter(item => matches(query, item.key, item.values.name, item.values.model, item.values.apibase));
  const entry = config?.entries.find(item => item.key === edit.id), provider = config?.providers.find(item => item.id === edit.id);
  const choose = (kind: Edit['kind'], id?: string) => { setError(''); setEdit(old => ({ kind, id, serial: old.serial + 1 })); };
  const filter = (id: string) => { setSection(id); const items = groups.find(item => item.id === id)?.entries || config?.entries || []; choose('model', items.find(item => matches(query, item.key, item.values.name, item.values.model, item.values.apibase))?.key); };
  async function load() {
    setConfig(null); setError(''); setQuery(''); setSection('');
    await run(async () => { const next = await api.host.get<ModelConfig>('/api/models/config'); setConfig(next); choose('model', next.entries[0]?.key); }, setError, true);
  }
  const change: SaveModel = (action, id, values) => {
    if (!config?.writable || busy) return;
    setError('');
    void run(async () => {
      const next = await api.host.post<ModelResult>('/api/models/config', { action, revision: config.revision, [action.startsWith('provider_') ? 'id' : 'key']: id, ...(values ? { values } : {}) });
      setConfig(next.config); api.setState(next.state);
      const saved = next.config.entries.find(item => item.key === id);
      const nextSection = action === 'provider_save' ? 'provider:' + id : saved && section ? sectionKey(saved) : section;
      setSection(modelSections(next.config).some(item => item.id === nextSection) ? nextSection : '');
      setQuery(''); choose('model', saved?.key || next.config.entries.find(item => !nextSection || sectionKey(item) === nextSection)?.key);
      api.notice(T('\u914d\u7f6e\u5df2\u4fdd\u5b58\u5e76\u751f\u6548', 'Configuration saved and applied'));
    }, setError);
  };
  const convert = () => { if (!config?.convert || config.convert.blocked) return; setError(''); void run(async () => {
    const next = await api.host.post<ModelResult>('/api/models/config', { action: 'convert' }); setConfig(next.config); api.setState(next.state); setSection(''); choose('model', next.config.entries[0]?.key);
    api.notice(T('\u5df2\u8f6c\u6362\u4e3a\u53ef\u7f16\u8f91\u914d\u7f6e', 'Converted to an editable configuration'));
  }, setError); };
  const locked = busy || !config?.writable;
  return <>
    <ModelPicker api={api} />
    {state.models && <SettingsPanel api={api} label={T('\u6a21\u578b', 'Models')} icon="cpu" order={10} className="gah-model-dialog" onOpen={load}>
      <div className="dialog-head"><h2>{T('\u6a21\u578b\u914d\u7f6e', 'Models')}</h2><button type="button" className="secondary" disabled={working} onClick={() => void load()}>{T('\u5237\u65b0', 'Refresh')}</button></div>
      <div className="dialog-content">
        {error && <p className="model-error" role="alert">{error}</p>}
        {!config && <p className="model-help">{working ? T('\u52a0\u8f7d\u4e2d...', 'Loading...') : T('\u52a0\u8f7d\u5931\u8d25', 'Unable to load configuration')}</p>}
        {config && <>
          {!config.writable && <p className="model-help">{readonlyText(config)}</p>}
          {config.convert && <div className="model-convert"><p className="model-help">{config.convert.target}</p><button type="button" disabled={busy || config.convert.blocked} onClick={convert}>{T('\u8f6c\u6362\u4e3a\u53ef\u7f16\u8f91\u914d\u7f6e', 'Convert to editable configuration')}</button></div>}
          <div className="model-layout">
            <div className="model-browser-tools"><input type="search" className="model-search" value={query} disabled={busy} placeholder={T('\u641c\u7d22\u6a21\u578b', 'Search models')} aria-label={T('\u641c\u7d22\u6a21\u578b', 'Search models')} onChange={event => setQuery(event.target.value)} /><select className="model-provider-filter" aria-label={T('\u670d\u52a1\u5546\u7b5b\u9009', 'Filter by provider')} value={section} disabled={busy} onChange={event => filter(event.target.value)}><option value="">{T('\u5168\u90e8\u6a21\u578b', 'All models')} ({config.entries.length})</option>{groups.map(item => <option key={item.id} value={item.id}>{item.title} ({item.entries.length})</option>)}</select><button type="button" disabled={locked} onClick={() => choose('provider')}>{T('\u65b0\u589e\u670d\u52a1\u5546', 'Add provider')}</button></div>
            <section className="model-section-body"><div className="model-section-head"><div className="model-section-heading"><h3>{group?.title || T('\u5168\u90e8\u6a21\u578b', 'All models')}</h3><p className="model-help">{entries.length} / {config.entries.length}</p></div><div className="model-section-actions">{group?.provider && <button type="button" className="secondary" disabled={busy} onClick={() => choose('provider', group.provider!.id)}>{T('\u7f16\u8f91\u670d\u52a1\u5546', 'Edit provider')}</button>}<button type="button" disabled={locked} onClick={() => choose('model')}>{T('\u65b0\u589e\u6a21\u578b', 'Add model')}</button></div></div>
              <div className="model-area"><div className="model-list" aria-label={T('\u6a21\u578b\u5217\u8868', 'Model list')}>
                {entries.map(item => <button key={item.key} type="button" className="model-list-item" disabled={busy} aria-pressed={edit.kind === 'model' && edit.id === item.key} onClick={() => choose('model', item.key)}><strong>{item.values.name || item.values.model || item.key}</strong><small>{item.values.model || item.key} · {groups.find(candidate => candidate.id === sectionKey(item))?.title}</small></button>)}
                {!entries.length && <p className="model-empty">{T('\u6ca1\u6709\u5339\u914d\u7684\u6a21\u578b', 'No matching models')}</p>}
              </div><div className="model-editor">{edit.kind === 'provider' ? <ProviderForm key={edit.serial} entry={provider} used={provider ? config.entries.filter(item => item.provider === provider.id).length : 0} disabled={locked} onSave={change} /> : <ModelForm key={edit.serial} entry={entry} config={config} initialProvider={group?.provider?.id} disabled={locked} onSave={change} />}</div></div>
            </section>
          </div>
        </>}
      </div>
    </SettingsPanel>}
  </>;
}

defineReact('web-models', Models);
