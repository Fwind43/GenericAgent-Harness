import { useCallback, useLayoutEffect, useState } from 'react';
import { T, confirmDialog, type ModelEntry, type ProviderEntry } from '@gah/sdk';
import { Credentials, Field, FormActions, Protocol, Section, useDraft, type RevealKey, type SaveModel } from './ModelForm';
import { RemoteModels, type FetchModels } from './RemoteModels';
import { ProviderModels, type QuickSave } from './ProviderModels';

const noop = () => {};
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 32);
const hostSlug = (url: string) => {
  try {
    const host = new URL(url.includes('://') ? url : `https://${url}`).hostname;
    if (host === 'localhost' || /^[\d.]+$|:/.test(host)) return 'local';
    const parts = host.split('.').filter(part => !['www', 'api'].includes(part));
    return slug(parts.length > 1 ? parts[parts.length - 2] : parts[0] || '');
  } catch { return ''; }
};
export function providerId(name: string, base: string, taken: Iterable<string>) {
  const used = new Set(taken), root = slug(name) || hostSlug(base) || 'provider';
  let id = root;
  for (let n = 2; used.has(id); n++) id = `${root}-${n}`;
  return id;
}
export function ProviderForm({ entry, taken = [], models, disabled, onSave, onQuickSave, onDirtyChange, onReset, onOpenModel, onNewModel, fetchModels, onAddModels, revealKey }: {
  entry?: ProviderEntry; taken?: string[]; models: ModelEntry[]; disabled: boolean; onSave: SaveModel; onQuickSave: QuickSave;
  onDirtyChange: (dirty: boolean) => void; onReset: () => void; onOpenModel: (key: string) => void; onNewModel: () => void;
  fetchModels: FetchModels; onAddModels: (provider: string, protocol: string, ids: string[]) => void; revealKey?: RevealKey;
}) {
  const [id, setId] = useState(entry?.id || ''), [name, setName] = useState(entry?.values.name || '');
  const [protocol, setProtocol] = useState(entry?.values.protocol || 'oai');
  const [base, setBase] = useState(entry?.values.apibase || ''), [secret, setSecret] = useState('');
  const used = models.length, existing = new Set(models.map(item => item.values.model || ''));
  const [modelDirty, setModelDirty] = useState(false), onModelDirty = useCallback((value: boolean) => setModelDirty(value), []);
  const auto = entry ? entry.id : providerId(name, base, taken), finalId = id.trim() || auto;
  const dirty = useDraft([id, name, protocol, base, secret], noop);
  useLayoutEffect(() => { onDirtyChange(dirty || modelDirty); }, [dirty, modelDirty, onDirtyChange]);
  useLayoutEffect(() => () => { onDirtyChange(false); }, [onDirtyChange]);
  return <form className="model-provider-form" onInvalidCapture={event => (event.target as HTMLElement).closest('details')?.setAttribute('open', '')} onSubmit={event => { event.preventDefault(); if (!disabled) onSave('provider_save', finalId, { name: name.trim(), protocol, apibase: base.trim(), apikey: secret }); }}>
    <div className="model-form-content">
      <Section title={T('\u670d\u52a1\u5546', 'Provider')} hint={T('\u5730\u5740\u548c\u5bc6\u94a5\u4f1a\u540c\u6b65\u5230\u4f7f\u7528\u6b64\u670d\u52a1\u5546\u7684\u6240\u6709\u6a21\u578b\u3002', 'URL and key are synced to every model that uses this provider.')}>
        <Field label={T('\u663e\u793a\u540d\u79f0', 'Display name')}><input disabled={disabled} value={name} maxLength={120} placeholder={T('\u4f8b\u5982 OpenAI', 'For example, OpenAI')} onChange={event => setName(event.target.value)} autoFocus={!entry} /></Field>
        <Protocol value={protocol} disabled={disabled} onChange={setProtocol} />
        <Credentials base={base} secret={secret} hasKey={entry?.has_key} hiddenURL={entry?.url_hidden} disabled={disabled} onBase={setBase} onSecret={setSecret} reveal={entry && revealKey ? () => revealKey({ provider: entry.id }) : undefined} />
      </Section>
      {entry && <Section title={T('\u6a21\u578b', 'Models')} hint={used ? T('\u70b9\u51fb\u6a21\u578b\u53ef\u76f4\u63a5\u7f16\u8f91\uff1b\u6709\u6a21\u578b\u65f6\u4e0d\u80fd\u5220\u9664\u670d\u52a1\u5546\u3002', 'Click a model to edit it here; a provider with models cannot be deleted.') : T('\u8fd8\u6ca1\u6709\u6a21\u578b\u4f7f\u7528\u6b64\u670d\u52a1\u5546\u3002', 'No models use this provider yet.')}>
        <ProviderModels provider={entry.id} models={models} disabled={disabled} onSave={onQuickSave} onOpen={onOpenModel} onAdd={onNewModel} onDirtyChange={onModelDirty} />
        <div className="wide"><RemoteModels source={{ provider: entry.id, protocol, apibase: base.trim(), apikey: secret }} existing={existing} disabled={disabled}
          fetchModels={fetchModels} onAdd={ids => onAddModels(entry.id, protocol, ids)} /></div>
      </Section>}
      <details className="model-advanced">
        <summary>{T('\u9ad8\u7ea7', 'Advanced')}</summary>
        <div className="model-grid">
          <Field label={T('\u670d\u52a1\u5546\u6807\u8bc6', 'Provider ID')} wide><input pattern="[a-z0-9][a-z0-9_\-]{0,39}" disabled={disabled || !!entry} value={id} placeholder={auto} spellCheck={false} onChange={event => setId(event.target.value)} /><small>{entry ? T('\u521b\u5efa\u540e\u4e0d\u53ef\u4fee\u6539\u3002', 'Fixed after creation.') : T('\u53ef\u7559\u7a7a\uff0c\u5c06\u6839\u636e\u540d\u79f0\u6216\u5730\u5740\u81ea\u52a8\u751f\u6210\uff1b\u521b\u5efa\u540e\u4e0d\u53ef\u4fee\u6539\u3002', 'Optional; generated from the name or URL. Fixed after creation.')}</small></Field>
        </div>
      </details>
    </div>
    <FormActions dirty={dirty} existing={!!entry} disabled={disabled} canDelete={used === 0} onReset={onReset} onDelete={async () => {
      if (await confirmDialog({ title: T('\u5220\u9664\u8fd9\u4e2a\u670d\u52a1\u5546\uff1f', 'Delete this provider?'), message: entry?.values.name || id, danger: true, confirm: T('\u5220\u9664', 'Delete') })) onSave('provider_delete', finalId);
    }} />
  </form>;
}
