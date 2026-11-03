import { useCallback, useLayoutEffect, useState } from 'react';
import { T, confirmDialog, type ModelEntry, type ProviderEntry } from '@gah/sdk';
import { Credentials, Field, FormActions, Protocol, Section, useDraft, type SaveModel } from './ModelForm';
import { RemoteModels, type FetchModels } from './RemoteModels';
import { ProviderModels, type QuickSave } from './ProviderModels';

const noop = () => {};
export function ProviderForm({ entry, models, disabled, onSave, onQuickSave, onDirtyChange, onReset, onOpenModel, onNewModel, fetchModels, onAddModels }: {
  entry?: ProviderEntry; models: ModelEntry[]; disabled: boolean; onSave: SaveModel; onQuickSave: QuickSave;
  onDirtyChange: (dirty: boolean) => void; onReset: () => void; onOpenModel: (key: string) => void; onNewModel: () => void;
  fetchModels: FetchModels; onAddModels: (provider: string, protocol: string, ids: string[]) => void;
}) {
  const [id, setId] = useState(entry?.id || ''), [name, setName] = useState(entry?.values.name || '');
  const [protocol, setProtocol] = useState(entry?.values.protocol || 'oai');
  const [base, setBase] = useState(entry?.values.apibase || ''), [secret, setSecret] = useState('');
  const used = models.length, existing = new Set(models.map(item => item.values.model || ''));
  const [modelDirty, setModelDirty] = useState(false), onModelDirty = useCallback((value: boolean) => setModelDirty(value), []);
  const dirty = useDraft([id, name, protocol, base, secret], noop);
  useLayoutEffect(() => { onDirtyChange(dirty || modelDirty); }, [dirty, modelDirty, onDirtyChange]);
  useLayoutEffect(() => () => { onDirtyChange(false); }, [onDirtyChange]);
  return <form className="model-provider-form" onInvalidCapture={event => (event.target as HTMLElement).closest('details')?.setAttribute('open', '')} onSubmit={event => { event.preventDefault(); if (!disabled) onSave('provider_save', id.trim(), { name: name.trim(), protocol, apibase: base.trim(), apikey: secret }); }}>
    <div className="model-form-content">
      <Section title={T('\u670d\u52a1\u5546', 'Provider')} hint={T('\u5730\u5740\u548c\u5bc6\u94a5\u4f1a\u540c\u6b65\u5230\u4f7f\u7528\u6b64\u670d\u52a1\u5546\u7684\u6240\u6709\u6a21\u578b\u3002', 'URL and key are synced to every model that uses this provider.')}>
        <Field label={T('\u663e\u793a\u540d\u79f0', 'Display name')}><input disabled={disabled} value={name} maxLength={120} placeholder={T('\u4f8b\u5982 OpenAI', 'For example, OpenAI')} onChange={event => setName(event.target.value)} autoFocus={!entry} /></Field>
        <Protocol value={protocol} disabled={disabled} onChange={setProtocol} />
        <Credentials base={base} secret={secret} hasKey={entry?.has_key} hiddenURL={entry?.url_hidden} disabled={disabled} onBase={setBase} onSecret={setSecret} />
      </Section>
      {entry && <Section title={T('\u6a21\u578b', 'Models')} hint={used ? T('\u70b9\u51fb\u6a21\u578b\u53ef\u76f4\u63a5\u7f16\u8f91\uff1b\u6709\u6a21\u578b\u65f6\u4e0d\u80fd\u5220\u9664\u670d\u52a1\u5546\u3002', 'Click a model to edit it here; a provider with models cannot be deleted.') : T('\u8fd8\u6ca1\u6709\u6a21\u578b\u4f7f\u7528\u6b64\u670d\u52a1\u5546\u3002', 'No models use this provider yet.')}>
        <ProviderModels provider={entry.id} models={models} disabled={disabled} onSave={onQuickSave} onOpen={onOpenModel} onAdd={onNewModel} onDirtyChange={onModelDirty} />
        <div className="wide"><RemoteModels source={{ provider: entry.id, protocol, apibase: base.trim(), apikey: secret }} existing={existing} disabled={disabled}
          fetchModels={fetchModels} onAdd={ids => onAddModels(entry.id, protocol, ids)} /></div>
      </Section>}
      <details className="model-advanced">
        <summary>{T('\u9ad8\u7ea7', 'Advanced')}</summary>
        <div className="model-grid">
          <Field label={T('\u670d\u52a1\u5546\u6807\u8bc6', 'Provider ID')} wide><input required pattern="[a-z0-9_-]+" disabled={disabled || !!entry} value={id} placeholder="openai" spellCheck={false} onChange={event => setId(event.target.value)} /><small>{T('\u5c0f\u5199\u5b57\u6bcd\u3001\u6570\u5b57\u3001_ \u6216 -\uff0c\u521b\u5efa\u540e\u4e0d\u53ef\u4fee\u6539\u3002', 'Lowercase letters, digits, _ or -; fixed after creation.')}</small></Field>
        </div>
      </details>
    </div>
    <FormActions dirty={dirty} existing={!!entry} disabled={disabled} canDelete={used === 0} onReset={onReset} onDelete={async () => {
      if (await confirmDialog({ title: T('\u5220\u9664\u8fd9\u4e2a\u670d\u52a1\u5546\uff1f', 'Delete this provider?'), message: entry?.values.name || id, danger: true, confirm: T('\u5220\u9664', 'Delete') })) onSave('provider_delete', id);
    }} />
  </form>;
}
